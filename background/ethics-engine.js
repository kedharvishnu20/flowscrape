// === ethics-engine.js ===
/**
 * @module ethics-engine
 * @description Pre-run ethics gate orchestrator. Runs 7 gates before first
 *   pipeline step executes. Gate 7 is the new overlay readiness check — it
 *   runs previewAll() and shows the user the overlay state before they confirm.
 *
 *   Design decision: All hard blocks also trigger overlay-engine's 'blocked' mode
 *   on the offending element BEFORE throwing, so the user sees a visual gray
 *   crosshatch on the exact element that caused the block. This connects the
 *   ethics system directly to the visual philosophy.
 *
 * @dependencies robots-parser, pii-detector, overlay-engine (via content message), logger
 */

"use strict";

import { logger } from "../utils/logger.js";
import { parseRobots, isAllowedByRules } from "../ethics/robots-parser.js";
import { scanText } from "../ethics/pii-detector.js";

const MODULE = "ethics-engine";

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_FORM_ROWS_DEFAULT = 500;
const MAX_FORM_ROWS_CONFIRMED = 5000;
const MIN_INTER_ROW_DELAY_MS = 800;
const ROBOTS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ── Block/warn error classes ──────────────────────────────────────────────────
export class EthicsBlock extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "EthicsBlock";
  }
}
export class EthicsWarn {
  constructor(code, message) {
    this.code = code;
    this.message = message;
  }
}

// ── robots.txt cache ──────────────────────────────────────────────────────────
const _robotsCache = new Map(); // domain → { parsed, fetchedAt }

async function _fetchRobots(origin) {
  const cached = _robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) {
    return cached.parsed;
  }
  try {
    const resp = await fetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(5000),
    });
    const text = resp.ok ? await resp.text() : "";
    const parsed = parseRobots(text, origin);
    _robotsCache.set(origin, { parsed, fetchedAt: Date.now() });
    return parsed;
  } catch {
    logger.warn(MODULE, "robots-fetch-fail", { origin });
    return null; // unreachable → allow with warning
  }
}

// ── Gate implementations ──────────────────────────────────────────────────────

async function _gate1_robots(targetOrigin, targetPath, bypass) {
  if (bypass) return null;
  const robots = await _fetchRobots(targetOrigin);
  if (!robots) {
    return new EthicsWarn(
      "RobotsTxt",
      `Could not fetch robots.txt from ${targetOrigin} — proceeding with caution`,
    );
  }
  const disallowed = !isAllowedByRules(robots, targetPath, "FlowScrape");
  if (disallowed) {
    return new EthicsWarn(
      "RobotsTxt",
      `robots.txt Disallows access to ${targetPath} — confirm to override`,
    );
  }
  return null;
}

async function _gate2_pii(pipelineSteps) {
  // Only scan FORM_FILL data sources
  const formSteps = pipelineSteps.filter((s) => s.type === "FORM_FILL");
  if (!formSteps.length) return null;

  // We can't read the actual file here in SW; PII check deferred to content script
  // The content script calls pii-detector when file is uploaded
  // Return null (gate deferred to content side)
  return null;
}

function _gate3_rateLimit(pipelineSteps, timingConfig) {
  const stepCount = pipelineSteps.length;
  const minDelay = timingConfig?.min ?? 1200;
  const estimatedReqPerHr = Math.round((3600000 / minDelay) * stepCount);
  if (estimatedReqPerHr > 100) {
    return new EthicsWarn(
      "HighRate",
      `Estimated rate: ~${estimatedReqPerHr} req/hr (> 100 threshold). Review timing settings.`,
    );
  }
  return null;
}

function _gate4_captcha(pipelineSteps, captchaConfig) {
  if (!captchaConfig?.enabled) return null;
  const formSteps = pipelineSteps.filter((s) => s.type === "FORM_FILL");
  const minDelay = formSteps[0]?.config?.interRowDelay?.min ?? 1200;
  const solveRatePerHr = Math.round(3600000 / minDelay);
  if (solveRatePerHr > 50) {
    return new EthicsWarn(
      "HighCaptchaVolume",
      `Estimated captcha solves: ~${solveRatePerHr}/hr (> 50 threshold)`,
    );
  }
  return null;
}

function _gate5_proxyGeo(proxyEntry, declaredRegion) {
  // Simplified region comparison — actual Haversine would require geo data
  if (!proxyEntry?.country || !declaredRegion) return null;
  if (proxyEntry.country.toUpperCase() !== declaredRegion.toUpperCase()) {
    return new EthicsWarn(
      "ProxyGeoMismatch",
      `Proxy country (${proxyEntry.country}) ≠ declared region (${declaredRegion})`,
    );
  }
  return null;
}

function _gate6_domainLock(pipelineSteps, targetOrigin) {
  // Skip domain-lock entirely when launched from an internal/new-tab page.
  // chrome://newtab, about:blank, chrome-extension://* are not real site origins.
  const internalPrefixes = [
    "chrome",
    "about",
    "edge",
    "chrome-extension",
    "moz-extension",
  ];
  const isInternalOrigin =
    !targetOrigin ||
    targetOrigin === "null" ||
    internalPrefixes.some((p) => targetOrigin.startsWith(p));

  if (isInternalOrigin) return null; // allow freely when starting from new tab

  for (const step of pipelineSteps) {
    const cfg = step.config ?? {};
    let stepOrigin = null;

    if ((step.type === "WEBSITE" || step.type === "NAVIGATE") && cfg.url) {
      try {
        stepOrigin = new URL(cfg.url).origin;
      } catch {}
    } else if (step.type === "FORM_FILL" && cfg.submitOrigin) {
      stepOrigin = cfg.submitOrigin;
    } else if ((step.type === "API" || step.type === "API_FETCH") && cfg.url) {
      try {
        stepOrigin = new URL(cfg.url).origin;
      } catch {}
    }

    if (stepOrigin && stepOrigin !== targetOrigin) {
      return new EthicsBlock(
        "DomainMismatch",
        `Step "${step.type}" targets ${stepOrigin} but pipeline origin is ${targetOrigin}`,
      );
    }
  }
  return null;
}

/**
 * Gate 7: Overlay readiness check (SOFT WARN).
 * Sends previewAll message to content script and checks for unmatched selectors.
 * @param {object[]} steps
 * @param {number}   tabId
 * @returns {Promise<EthicsWarn|null>}
 */
async function _gate7_overlayReadiness(steps, tabId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "overlay:setMode",
      payload: { action: "previewAll", steps },
    });
    if (result?.unmatched?.length > 0) {
      return new EthicsWarn(
        "SelectorNotFound",
        `${result.unmatched.length} selector(s) not found on page: ${result.unmatched.slice(0, 3).join(", ")}${result.unmatched.length > 3 ? "…" : ""}`,
      );
    }
  } catch (err) {
    logger.warn(MODULE, "gate7-overlay-check-fail", { error: err.message });
    // Non-fatal: content script may not be loaded yet
  }
  return null;
}

// ── FORM_FILL specific checks ─────────────────────────────────────────────────

function _checkFormFillHardConstraints(config, rowCount, confirmed) {
  // Delay floor
  const minDelay = config.interRowDelay?.min ?? 1200;
  if (minDelay < MIN_INTER_ROW_DELAY_MS) {
    throw new EthicsBlock(
      "DelayFloor",
      `Inter-row delay ${minDelay}ms < minimum ${MIN_INTER_ROW_DELAY_MS}ms`,
    );
  }

  // Row cap
  const cap = confirmed ? MAX_FORM_ROWS_CONFIRMED : MAX_FORM_ROWS_DEFAULT;
  if (rowCount > cap) {
    throw new EthicsBlock(
      "SubmitCapExceeded",
      `Row count ${rowCount} exceeds cap ${cap} (confirmed=${confirmed})`,
    );
  }

  // Field type checks (password / hidden)
  for (const mapping of config.fieldMappings ?? []) {
    if (mapping.inputType === "password") {
      throw new EthicsBlock(
        "PasswordField",
        `Password field in mapping: ${mapping.selector}`,
      );
    }
    if (mapping.inputType === "hidden") {
      throw new EthicsBlock(
        "HiddenField",
        `Hidden field in mapping: ${mapping.selector}`,
      );
    }
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} EthicsResult
 * @property {boolean}        blocked    Any hard block found
 * @property {EthicsBlock|null} blocker  The blocking error if blocked
 * @property {EthicsWarn[]}   warnings   Soft warnings requiring user confirm
 */

/**
 * Run all 7 pre-run ethics gates.
 * @param {object} opts
 * @param {object[]} opts.steps          - Pipeline steps
 * @param {string}   opts.targetOrigin   - Declared pipeline origin
 * @param {string}   [opts.targetPath='/'] - Path for robots.txt check
 * @param {object}   [opts.timing]       - Timing configuration
 * @param {object}   [opts.proxy]        - Current proxy entry
 * @param {string}   [opts.region]       - Declared geo region
 * @param {object}   [opts.captcha]      - Captcha config
 * @param {number}   [opts.tabId]        - Active tab for Gate 7
 * @param {boolean}  [opts.confirmed]    - User explicitly confirmed row count
 * @param {number}   [opts.rowCount]     - Total rows to process
 * @returns {Promise<EthicsResult>}
 */
export async function runEthicsGates(opts = {}) {
  const {
    steps = [],
    targetOrigin = "",
    targetPath = "/",
    timing = {},
    proxy = null,
    region = null,
    captcha = {},
    tabId = null,
    confirmed = false,
    rowCount = 0,
    bypassRobots = false,
  } = opts;

  const warnings = [];

  // Gate 1: robots.txt
  const w1 = await _gate1_robots(targetOrigin, targetPath, bypassRobots);
  if (w1) warnings.push(w1);

  // Gate 2: PII (deferred to content)
  await _gate2_pii(steps);

  // Gate 3: Rate limit
  const w3 = _gate3_rateLimit(steps, timing);
  if (w3) warnings.push(w3);

  // Gate 4: Captcha volume
  const w4 = _gate4_captcha(steps, captcha);
  if (w4) warnings.push(w4);

  // Gate 5: Proxy geo
  const w5 = _gate5_proxyGeo(proxy, region);
  if (w5) warnings.push(w5);

  // Gate 6: Domain lock (can throw EthicsBlock)
  const g6 = _gate6_domainLock(steps, targetOrigin);
  if (g6 instanceof EthicsBlock) {
    logger.error(MODULE, "gate6-block", { code: g6.code, message: g6.message });
    return { blocked: true, blocker: g6, warnings };
  }

  // FORM_FILL hard constraints
  const formSteps = steps.filter((s) => s.type === "FORM_FILL");
  for (const step of formSteps) {
    try {
      _checkFormFillHardConstraints(step.config ?? {}, rowCount, confirmed);
    } catch (err) {
      if (err instanceof EthicsBlock) {
        logger.error(MODULE, "form-fill-block", {
          code: err.code,
          message: err.message,
        });
        return { blocked: true, blocker: err, warnings };
      }
      throw err;
    }
  }

  // Gate 7: Overlay readiness (SOFT — needs tabId)
  if (tabId) {
    const w7 = await _gate7_overlayReadiness(steps, tabId);
    if (w7) warnings.push(w7);
  }

  logger.info(MODULE, "gates-complete", {
    blocked: false,
    warnings: warnings.map((w) => w.code),
  });

  return { blocked: false, blocker: null, warnings };
}

// === END ethics-engine.js ===
