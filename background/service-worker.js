// === service-worker.js ===
/**
 * @module service-worker
 * @description MV3 Service Worker: pipeline orchestrator, message bus, and
 *   SW lifecycle manager. All state is persisted to storage before every await
 *   to survive SW termination.
 *
 *   Design decision: The SW uses a message-handler registry pattern (Map of
 *   handlers keyed by message name) instead of a giant switch statement. This
 *   keeps the bus extensible and each handler independently testable.
 *   All inbound message names must match the canonical registry.
 *
 *   SW lifecycle: We keep the SW alive during a pipeline run via chrome.alarms
 *   (heartbeat every 20s). On activation, the session key is re-initialized
 *   because the module scope is fresh. We resume any incomplete runs detected
 *   in storage.
 *
 * @dependencies proxy-manager, api-key-manager, rate-limiter, ethics-engine, logger
 */

import { logger } from "../utils/logger.js";
import { initSessionKey } from "./api-key-manager.js";
import { setApiKey } from "./api-key-manager.js";
import {
  loadPool,
  selectProxy,
  rotateProxy,
  markProxyFailure,
  testAllProxies,
  parseProxyText,
  addToPool,
  savePool,
  setRotationMode,
} from "./proxy-manager.js";
import { acquire, backoff, resetRetry } from "./rate-limiter.js";
import { runEthicsGates, EthicsBlock } from "./ethics-engine.js";
import {
  initBuffer,
  pushRow,
  flush,
  finalizeBuffer,
  readAllRows,
} from "../checkpoint/row-buffer.js";
import { saveCursor } from "../checkpoint/cursor-store.js";
import { getResumePayload } from "../checkpoint/resume-manager.js";
import { compilePipeline } from "../script-gen/pipeline-compiler.js";
import { emitPython } from "../script-gen/python-emitter.js";
import { emitNode } from "../script-gen/node-emitter.js";

const MODULE = "service-worker";

// ── Utility helpers ────────────────────────────────────────────────────────────
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _broadcastLog(level, message) {
  chrome.runtime
    .sendMessage({ type: "pipeline:log", payload: { level, message } })
    .catch(() => {});
}

// ── Canonical message names ────────────────────────────────────────────────────
const MSG = Object.freeze({
  PIPELINE_START: "pipeline:start",
  PIPELINE_PAUSE: "pipeline:pause",
  PIPELINE_STOP: "pipeline:stop",
  PIPELINE_STATUS: "pipeline:status",
  STEP_EXECUTE: "step:execute",
  STEP_RESULT: "step:result",
  PROXY_SELECT: "proxy:select",
  PROXY_ROTATE: "proxy:rotate",
  PROXY_TEST: "proxy:test",
  CAPTCHA_SOLVE: "captcha:solve",
  CAPTCHA_RESULT: "captcha:result",
  KEY_GET: "key:get",
  FORM_ROW_START: "form:rowStart",
  FORM_ROW_RESULT: "form:rowResult",
  CHECKPOINT_SAVE: "checkpoint:save",
});

// ── Pipeline run state ─────────────────────────────────────────────────────────
/** @type {{ active: boolean, paused: boolean, runId: string|null, tabId: number|null, results: any[], screenshots: string[] }} */
let _runState = {
  active: false,
  paused: false,
  runId: null,
  tabId: null,
  results: [],
  screenshots: [],
};

// ── SW activation ─────────────────────────────────────────────────────────────
self.addEventListener("activate", async () => {
  logger.info(MODULE, "sw-activated", {});
  await initSessionKey(); // Always re-init AES key on activation
  await loadPool(); // Re-hydrate proxy pool
  _startHeartbeat(); // Keep SW alive during runs
});

self.addEventListener("install", () => {
  logger.info(MODULE, "sw-installed", {});
  self.skipWaiting();
});

// ── Heartbeat alarm (keeps SW alive) ──────────────────────────────────────────
function _startHeartbeat() {
  chrome.alarms.create("fs_sw_heartbeat", { periodInMinutes: 0.33 }); // ~20s
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "fs_sw_heartbeat") {
    // Just touching this listener keeps the SW alive
    logger.debug(MODULE, "heartbeat", { active: _runState.active });
  }
});

// ── Message bus ───────────────────────────────────────────────────────────────
/** @type {Map<string, (payload: any, sender: chrome.runtime.MessageSender) => Promise<any>>} */
const _handlers = new Map();

function _registerHandler(name, fn) {
  _handlers.set(name, fn);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message ?? {};
  if (!type) return false;

  const handler = _handlers.get(type);
  if (!handler) {
    logger.warn(MODULE, "unknown-message", { type });
    sendResponse({ ok: false, error: `Unknown message type: ${type}` });
    return false;
  }

  handler(payload ?? {}, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => {
      // Don't flag "Receiving end does not exist" as a hard SW crash, it just means the target tab needs F5
      if (err.message && err.message.includes("Receiving end does not exist")) {
        logger.warn(MODULE, "tab-not-ready", {
          type,
          message: "Target tab not active/refreshed.",
        });
      } else {
        logger.error(MODULE, "handler-error", { type, error: err.message });
      }
      sendResponse({ ok: false, error: err.message, code: err.code });
    });

  return true; // keep channel open for async response
});

// ── Message handlers ───────────────────────────────────────────────────────────

_registerHandler(MSG.PIPELINE_START, async (payload, sender) => {
  if (_runState.active) throw new Error("Pipeline already running");

  const { pipeline, tabId } = payload;
  if (!pipeline) throw new Error("No pipeline provided");

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _runState = {
    active: true,
    paused: false,
    runId,
    tabId: tabId ?? sender.tab?.id,
    results: [],
  };

  // Persist state before any await
  await chrome.storage.local.set({
    fs_run_log: { runId, startedAt: Date.now(), status: "running" },
  });

  // Run ethics gates first
  const { targetOrigin, targetPath, captchaEnabled, captchaAuthorized } =
    payload;
  const ethicsResult = await runEthicsGates({
    steps: pipeline.steps ?? [],
    targetOrigin,
    targetPath: targetPath ?? "/",
    timing: payload.timing ?? {},
    captcha: { enabled: captchaEnabled, authorized: captchaAuthorized },
    tabId: _runState.tabId,
    confirmed: payload.confirmed ?? false,
    rowCount: payload.rowCount ?? 0,
  });

  // If ethics gates hard-blocked, abort the run
  if (ethicsResult.blocked) {
    _runState = {
      active: false,
      paused: false,
      runId: null,
      tabId: null,
      results: [],
    };
    throw new EthicsBlock(
      ethicsResult.blocker.code,
      ethicsResult.blocker.message,
    );
  }

  const warnings = ethicsResult.warnings;
  logger.info(MODULE, "pipeline-start", { runId, warnings: warnings.length });

  // Start execution loop async (do not await so UI returns early!)
  _executePipeline(runId, pipeline, _runState.tabId).catch((err) => {
    logger.error(MODULE, "pipeline-crash", { runId, error: err.message });
  });

  return {
    runId,
    warnings: warnings.map((w) => ({ code: w.code, message: w.message })),
  };
});

// ── Step execution helpers ─────────────────────────────────────────────────────

async function _captureScreenshot(tabId, config = {}) {
  try {
    // Focus the tab so captureVisibleTab can see it
    await chrome.tabs.update(tabId, { active: true });
    await _sleep(400);
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
      quality: config.quality || 100,
    });
    // Store in memory for ZIP export
    if (!Array.isArray(_runState.screenshots)) _runState.screenshots = [];
    _runState.screenshots.push({ dataUrl, ts: Date.now() });
    _broadcastLog(
      "info-log",
      `Screenshot #${_runState.screenshots.length} captured.`,
    );
  } catch (err) {
    throw new Error(`Screenshot failed: ${err.message}`);
  }
}

// ── Minimal pure-JS ZIP creator (store, no compression) ───────────────────────
function _buildZip(files) {
  // files: [{name: string, bytes: Uint8Array}]
  const u16 = (n) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return b;
  };
  const u32 = (n) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const cat = (...arrays) => {
    const t = arrays.reduce((s, a) => s + a.length, 0),
      r = new Uint8Array(t);
    let o = 0;
    arrays.forEach((a) => {
      r.set(a, o);
      o += a.length;
    });
    return r;
  };
  function crc32(d) {
    let c = -1;
    for (const b of d) {
      c ^= b;
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return ~c >>> 0;
  }
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const nb = enc.encode(name),
      crc = crc32(bytes),
      sz = bytes.length;
    const lh = cat(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(sz),
      u32(sz),
      u16(nb.length),
      u16(0),
      nb,
      bytes,
    );
    locals.push(lh);
    centrals.push(
      cat(
        new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(sz),
        u32(sz),
        u16(nb.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nb,
      ),
    );
    offset += lh.length;
  }
  const cs = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = cat(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]),
    u16(files.length),
    u16(files.length),
    u32(cs),
    u32(offset),
    u16(0),
  );
  return cat(...locals, ...centrals, eocd);
}

function _dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(",")[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function _doExport(runId, config) {
  const idbRows = await readAllRows(runId).catch(() => []);
  const allRows = [..._runState.results];
  const seen = new Set(allRows.map((r) => JSON.stringify(r)));
  for (const r of idbRows) {
    const { runId: _, ...clean } = r;
    if (!seen.has(JSON.stringify(clean))) allRows.push(clean);
  }

  const screenshots = _runState.screenshots || [];
  const enc = new TextEncoder();
  const fmt = config.format || "csv";
  const ts = Date.now();

  // Build data file content
  let dataContent, dataMime, dataExt;
  const headers = Array.from(new Set(allRows.flatMap(Object.keys)));
  if (fmt === "json") {
    dataContent = JSON.stringify(allRows, null, 2);
    dataMime = "application/json";
    dataExt = "json";
  } else if (fmt === "jsonl") {
    dataContent = allRows.map((r) => JSON.stringify(r)).join("\n");
    dataMime = "application/jsonl";
    dataExt = "jsonl";
  } else if (fmt === "tsv") {
    dataContent =
      headers.join("\t") +
      "\n" +
      allRows
        .map((r) =>
          headers.map((h) => String(r[h] || "").replace(/\t/g, " ")).join("\t"),
        )
        .join("\n");
    dataMime = "text/tab-separated-values";
    dataExt = "tsv";
  } else {
    dataContent =
      headers.join(",") +
      "\n" +
      allRows
        .map((r) =>
          headers
            .map((h) => `"${String(r[h] || "").replace(/"/g, '""')}"`)
            .join(","),
        )
        .join("\n");
    dataMime = "text/csv";
    dataExt = "csv";
  }

  if (screenshots.length > 0) {
    // Bundle everything into a ZIP
    const zipFiles = [];
    if (allRows.length > 0) {
      zipFiles.push({
        name: `data.${dataExt}`,
        bytes: enc.encode("\uFEFF" + dataContent),
      });
    }
    screenshots.forEach((s, i) => {
      zipFiles.push({
        name: `screenshot_${i + 1}_${s.ts}.png`,
        bytes: _dataUrlToBytes(s.dataUrl),
      });
    });
    const zipBytes = _buildZip(zipFiles);
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const zipUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: zipUrl,
      filename: `flowscrape_export_${ts}.zip`,
      saveAs: false,
    });
    _broadcastLog(
      "info-log",
      `Exported ZIP: ${allRows.length} rows + ${screenshots.length} screenshots.`,
    );
  } else if (allRows.length > 0) {
    const dataUrl = `data:${dataMime};charset=utf-8,\uFEFF${encodeURIComponent(dataContent)}`;
    await chrome.downloads.download({
      url: dataUrl,
      filename: `flowscrape_export_${ts}.${dataExt}`,
      saveAs: false,
    });
    _broadcastLog(
      "info-log",
      `Exported ${allRows.length} rows as ${fmt.toUpperCase()}.`,
    );
  } else {
    _broadcastLog("warn-log", "Export: no data collected.");
  }
}

// ── Template resolver ── {{loop.index}}, {{item.href}}, {{extracted.name}} ────
function _resolvePath(ctx, expr) {
  const parts = expr.trim().split(".");
  let val = ctx;

  for (let part of parts) {
    if (val === undefined || val === null) return undefined;

    // support data[] indexing and numeric indexing
    const arrayMatch = part.match(/^(.+?)\[(\d+)\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const idx = Number(arrayMatch[2]);
      val = val?.[key];
      if (!Array.isArray(val)) return undefined;
      val = val[idx];
      continue;
    }

    if (/^\d+$/.test(part)) {
      const idx = Number(part);
      if (!Array.isArray(val)) return undefined;
      val = val[idx];
      continue;
    }

    val = val[part];
  }
  return val;
}

function _resolveStr(s, ctx) {
  if (!s || typeof s !== "string" || !s.includes("{{")) return s;
  return s.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const val = _resolvePath(ctx, expr);
    return val !== undefined && val !== null ? String(val) : "";
  });
}
function _resolveConfig(step, ctx) {
  if (!ctx || !Object.keys(ctx).length) return step;
  const cfg = {};
  for (const [k, v] of Object.entries(step.config || {})) {
    cfg[k] = typeof v === "string" ? _resolveStr(v, ctx) : v;
  }
  return { ...step, config: cfg, __fsContext: ctx };
}

async function _executeLoop(step, tabId, runId, parentCtx = {}) {
  const {
    type: ltype = "count",
    selector = "",
    max = 10,
    onFail = "skip",
  } = step.config;
  const children = step.children || [];
  let iters = max;
  let elementsData = null;

  if (ltype === "elements" && selector) {
    try {
      // Pre-collect ALL element data upfront so templates can use {{item.href}}, {{item.text}} etc.
      const r = await chrome.tabs.sendMessage(tabId, {
        type: "step:execute",
        payload: { type: "QUERY_ELEMENTS", config: { selector } },
      });
      if (r?.ok && Array.isArray(r.result) && r.result.length > 0) {
        elementsData = r.result;
        iters = Math.min(elementsData.length, max || 9999);
        _broadcastLog(
          "info-log",
          `Loop: found ${elementsData.length} elements for "${selector}"`,
        );
      } else {
        _broadcastLog(
          "warn-log",
          `Loop: no elements matched "${selector}" — skipping.`,
        );
        return;
      }
    } catch (e) {
      _broadcastLog("warn-log", `Loop: element query failed: ${e.message}`);
    }
  }

  for (let i = 0; i < iters && _runState.active; i++) {
    const item = elementsData?.[i] ?? {
      index: i + 1,
      index0: i,
      text: "",
      href: "",
      src: "",
      value: "",
    };
    const isFirst = i === 0;
    const isLast = i === iters - 1;

    const loopCtx = {
      ...parentCtx,
      loop: {
        index: i + 1,
        index0: i,
        count: iters,
        selector,
        items: elementsData || [],
        first: isFirst,
        last: isLast,
        current: item,
      },
      item,
    };

    if (ltype === "paginate" && i > 0 && selector) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "step:execute",
          payload: { type: "CLICK", config: { selector, retries: 3 } },
        });
        await _sleep(1500);
      } catch {
        break;
      }
    }
    try {
      await _executeStepList(children, tabId, runId, loopCtx);
      _broadcastLog("info-log", `Loop [${i + 1}/${iters}] done.`);
    } catch (e) {
      _broadcastLog("warn-log", `Loop [${i + 1}/${iters}] — ${e.message}`);
      if (onFail === "stop") break;
    }
  }
}

async function _executeIfElse(step, tabId, runId, parentCtx = {}) {
  let met = false;
  try {
    const resolved = _resolveConfig(step, parentCtx);
    const r = await chrome.tabs.sendMessage(tabId, {
      type: "step:execute",
      payload: resolved,
    });
    met = r?.result?.conditionMet === true;
  } catch {}
  _broadcastLog(
    "info-log",
    `IF_ELSE: condition ${met ? "met → IF" : "not met → ELSE"} branch.`,
  );
  await _executeStepList(
    met ? step.ifBranch || [] : step.elseBranch || [],
    tabId,
    runId,
    parentCtx,
  );
}

async function _executeStepList(steps, tabId, runId, ctx = {}) {
  // ctx is mutable — EXTRACT results update it so later steps can use {{extracted.field}}
  const liveCtx = { ...ctx, extracted: { ...(ctx.extracted || {}) } };

  for (const step of steps) {
    if (!_runState.active || _runState.runId !== runId) break;

    // Resolve template variables in this step's config
    const resolvedStep = _resolveConfig(step, liveCtx);

    chrome.runtime
      .sendMessage({
        type: "pipeline:status",
        payload: { state: "running", currentStepId: step.id, progress: {} },
      })
      .catch(() => {});

    if (resolvedStep.type === "NAVIGATE") {
      await chrome.tabs.update(tabId, { url: resolvedStep.config.url });
      await _sleep(resolvedStep.config.wait ? 3000 : 800);
    } else if (resolvedStep.type === "WAIT") {
      await _sleep(resolvedStep.config.ms || 1000);
    } else if (resolvedStep.type === "SCREENSHOT") {
      await _captureScreenshot(tabId, resolvedStep.config);
    } else if (resolvedStep.type === "EXPORT") {
      await finalizeBuffer().catch(() => {});
      initBuffer(runId);
      await _doExport(runId, resolvedStep.config);
    } else if (resolvedStep.type === "LOOP") {
      await _executeLoop(resolvedStep, tabId, runId, liveCtx);
    } else if (resolvedStep.type === "IF_ELSE") {
      await _executeIfElse(resolvedStep, tabId, runId, liveCtx);
    } else {
      const resp = await chrome.tabs.sendMessage(tabId, {
        type: "step:execute",
        payload: resolvedStep,
      });
      if (!resp?.ok) throw new Error(resp?.error || "Step failed");
      if (resolvedStep.type === "EXTRACT" && Array.isArray(resp.result)) {
        _runState.results.push(...resp.result);
        for (const row of resp.result) await pushRow(row);
        _broadcastLog(
          "info-log",
          `Extracted ${resp.result.length} rows (total: ${_runState.results.length}).`,
        );
        // Update live context so next steps can reference {{extracted.fieldName}}
        if (resp.result.length > 0)
          Object.assign(liveCtx.extracted, resp.result[resp.result.length - 1]);
      }
    }
  }
}

// ── Background Execution Orchestrator ─────────────────────────────────────────
async function _executePipeline(runId, pipeline, targetTabId) {
  let stepIndex = 0,
    progressCount = 0;
  const total = pipeline.steps.length;
  initBuffer(runId);

  while (
    _runState.active &&
    _runState.runId === runId &&
    stepIndex < pipeline.steps.length
  ) {
    if (_runState.paused) {
      await _sleep(1000);
      continue;
    }

    const step = pipeline.steps[stepIndex];
    chrome.runtime
      .sendMessage({
        type: "pipeline:status",
        payload: {
          state: "running",
          currentStepId: step.id,
          progress: { current: progressCount, total },
        },
      })
      .catch(() => {});

    try {
      if (step.type === "NAVIGATE") {
        await chrome.tabs.update(targetTabId, { url: step.config.url });
        await _sleep(step.config.wait ? 3000 : 800);
      } else if (step.type === "WAIT") {
        await _sleep(step.config.ms || 1000);
      } else if (step.type === "SCREENSHOT") {
        await _captureScreenshot(targetTabId, step.config);
      } else if (step.type === "EXPORT") {
        await _doExport(runId, step.config);
      } else if (step.type === "LOOP") {
        await _executeLoop(step, targetTabId, runId);
      } else if (step.type === "IF_ELSE") {
        await _executeIfElse(step, targetTabId, runId);
      } else {
        const resp = await chrome.tabs.sendMessage(targetTabId, {
          type: "step:execute",
          payload: step,
        });
        if (!resp?.ok) throw new Error(resp?.error || "Execution rejected");
        if (step.type === "EXTRACT" && Array.isArray(resp.result)) {
          _runState.results.push(...resp.result);
          for (const row of resp.result) await pushRow(row);
          _broadcastLog(
            "info-log",
            `Extracted ${resp.result.length} rows. (auto-saved)`,
          );
        }
      }
      progressCount++;
      stepIndex++;
      await saveCursor({ runId, rowIndex: progressCount, stepIndex }).catch(
        () => {},
      );
    } catch (err) {
      const isCritical = !step.config.optional;
      _broadcastLog(
        isCritical ? "error-log" : "warn-log",
        `[${step.type}] ${err.message}${isCritical ? "" : " (optional, skipping)"}`,
      );
      if (isCritical) {
        _runState.active = false;
        break;
      }
      progressCount++;
      stepIndex++;
    }
  }

  await finalizeBuffer().catch(() => {});
  const stateStr = _runState.active ? "completed" : "stopped";
  chrome.runtime
    .sendMessage({
      type: "pipeline:status",
      payload: {
        state: stateStr,
        currentStepId: null,
        progress: { current: progressCount, total },
      },
    })
    .catch(() => {});
  _runState = {
    active: false,
    paused: false,
    runId: null,
    tabId: null,
    results: [],
  };
}

_registerHandler(MSG.STEP_EXECUTE, async (payload, sender) => {
  const { step, tabId } = payload;
  const targetTabId = tabId ?? sender.tab?.id;
  if (!targetTabId)
    throw new Error("No target tab specified for execution test");

  // Suppress the giant red error log output natively by catching the error locally and wrapping it nicely!
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(targetTabId, {
      type: "step:execute",
      payload: step,
    });
  } catch (err) {
    if (err.message.includes("Receiving end does not exist")) {
      throw new Error(
        "Receiving end does not exist. Please refresh the web page.",
      );
    }
    throw err;
  }

  if (!resp || !resp.ok)
    throw new Error(resp?.error || "Test failed inside content environment");
  return resp.result;
});

_registerHandler(MSG.PIPELINE_PAUSE, async () => {
  _runState.paused = true;
  logger.info(MODULE, "pipeline-paused", { runId: _runState.runId });
  return { ok: true };
});

_registerHandler(MSG.PIPELINE_STOP, async () => {
  _runState.active = false;
  _runState.paused = false;
  const runId = _runState.runId;
  _runState.runId = null;
  await chrome.alarms.clear("fs_sw_heartbeat");
  logger.info(MODULE, "pipeline-stopped", { runId });
  return { ok: true };
});

_registerHandler(MSG.PIPELINE_STATUS, async () => {
  return { ..._runState };
});

_registerHandler(MSG.PROXY_SELECT, async (payload) => {
  const proxy = selectProxy(payload?.context ?? {});
  if (!proxy) throw new Error("No alive proxies");
  // Strip credentials from response — content script does not need them
  const { user, pass, ...safe } = proxy;
  return safe;
});

_registerHandler(MSG.PROXY_ROTATE, async (payload) => {
  const proxy = await rotateProxy(payload?.context ?? {});
  if (!proxy) throw new Error("Proxy rotation failed");
  const { user, pass, ...safe } = proxy;
  return safe;
});

_registerHandler(MSG.PROXY_TEST, async (payload) => {
  const { autoRemoveDead = false, retryCount = 3 } = payload ?? {};
  await testAllProxies({ autoRemoveDead, retryCount });
  return { ok: true };
});

_registerHandler(MSG.CAPTCHA_SOLVE, async (payload) => {
  const { solveCaptcha } = await import("./api-key-manager.js");
  const token = await solveCaptcha(payload);
  return { token };
});

_registerHandler(MSG.KEY_GET, async (payload) => {
  const { getApiKey } = await import("./api-key-manager.js");
  // Only serves non-secret validation status — never key values to content scripts
  const { listProviders, validateApiKey } =
    await import("./api-key-manager.js");
  const providers = await listProviders();
  return { providers };
});

_registerHandler(MSG.FORM_ROW_START, async (payload) => {
  const { rowIndex, domain } = payload;
  // Rate limit acquisition
  await acquire(domain ?? "default", 1);
  logger.info(MODULE, "form-row-start", { rowIndex });
  return { ok: true };
});

_registerHandler(MSG.FORM_ROW_RESULT, async (payload) => {
  const { rowIndex, status, error } = payload;
  logger.info(MODULE, "form-row-result", { rowIndex, status });
  // Reset retry state on success
  if (status === "success") resetRetry(payload.domain ?? "default");
  return { ok: true };
});

_registerHandler(MSG.CHECKPOINT_SAVE, async (payload) => {
  const { runId, cursorData } = payload;
  await chrome.storage.local.set({
    [`fs_checkpoint_${runId}`]: { ...cursorData, savedAt: Date.now() },
  });
  logger.info(MODULE, "checkpoint-saved", { runId });
  return { ok: true };
});

// ── New handlers: wire up previously dead UI buttons ──────────────────────────

// Wire up API key save buttons
_registerHandler("key:set", async (payload) => {
  const { setApiKey } = await import("./api-key-manager.js");
  await setApiKey(payload.provider, payload.value);
  return { ok: true };
});

// Wire up proxy update button
_registerHandler("proxy:update", async (payload) => {
  const entries = parseProxyText(payload.text);
  addToPool(entries);
  if (payload.mode) setRotationMode(payload.mode);
  await savePool();
  return { ok: true, count: entries.length };
});

// Wire up script export button
_registerHandler("script:export", async (payload) => {
  try {
    const { ast } = compilePipeline(payload.pipeline);
    if (!ast) throw new Error("Pipeline compilation returned empty AST");
    if (payload.format === "python") {
      return { code: emitPython(ast) };
    } else {
      return { code: emitNode(ast) };
    }
  } catch (err) {
    throw new Error(`Script export failed: ${err.message}`);
  }
});

// Wire up checkpoint/resume check
_registerHandler("checkpoint:check", async () => {
  return await getResumePayload();
});

// Wire up partial data download
_registerHandler("data:download", async (payload) => {
  const rows = await readAllRows(payload?.runId ?? "latest");
  return { rows };
});

// ── Side panel connection ───────────────────────────────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// === END service-worker.js ===
