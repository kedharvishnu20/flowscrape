// === robots-parser.js ===
/**
 * @module robots-parser
 * @description RFC 9309-compliant robots.txt parser.
 *   Fetches and caches the robots.txt for a target origin, then answers
 *   isAllowed(path, userAgent) queries. Used by ethics-engine.js.
 *
 *   Design decision: We implement the parser ourselves (no remote libs — MV3
 *   CSP forbids remote scripts) using the RFC 9309 matching spec: longest-path
 *   match wins, $ anchors path end, * is wildcard.
 *
 * @dependencies logger
 */

import { logger } from '../utils/logger.js';

const MODULE = 'robots-parser';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const FS_USER_AGENT = 'FlowScrape';

/** @type {Map<string, { rules: ParsedRobots, fetchedAt: number }>} */
const _cache = new Map();

/**
 * @typedef {Object} Rule
 * @property {string}  path
 * @property {boolean} allow
 */

/**
 * @typedef {Object} ParsedRobots
 * @property {Map<string, Rule[]>} agentRules  ua → rules array
 * @property {number}              crawlDelay  seconds (0 if not set)
 * @property {string[]}            sitemaps
 */

/**
 * Parse robots.txt content into structured rules.
 * @param {string} text
 * @returns {ParsedRobots}
 */
export function parseRobots(text) {
  const agentRules = new Map();
  const sitemaps   = [];
  let crawlDelay   = 0;

  let currentAgents = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim(); // strip comments
    if (!line) {
      currentAgents = [];
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    switch (field) {
      case 'user-agent':
        currentAgents.push(value.toLowerCase());
        break;

      case 'disallow':
      case 'allow': {
        const rule = { path: value, allow: field === 'allow' };
        for (const agent of currentAgents) {
          if (!agentRules.has(agent)) agentRules.set(agent, []);
          agentRules.get(agent).push(rule);
        }
        break;
      }

      case 'crawl-delay':
        crawlDelay = parseFloat(value) || 0;
        break;

      case 'sitemap':
        sitemaps.push(value);
        break;
    }
  }

  return { agentRules, crawlDelay, sitemaps };
}

/**
 * RFC 9309 §2.2.2 path matching.
 * @param {string} rulePattern
 * @param {string} path
 * @returns {boolean}
 */
function _pathMatches(rulePattern, path) {
  if (!rulePattern) return true; // empty pattern = matches nothing (treat as allow-all)

  // Escape regex special chars except * and $
  let regex = rulePattern
    .replace(/[-[\]{}()+?.,\\^|#\s]/g, '\\$&')
    .replace(/\*/g, '.*');

  if (regex.endsWith('\\$')) {
    // $ at end means end of path
    regex = regex.slice(0, -2) + '$';
  }

  try {
    return new RegExp(`^${regex}`).test(path);
  } catch {
    return false;
  }
}

/**
 * Given parsed rules, check if a path is allowed for a user-agent.
 * Longest-matching rule wins (RFC 9309 §2.2.2).
 * @param {ParsedRobots} parsed
 * @param {string} path
 * @param {string} [userAgent='FlowScrape']
 * @returns {boolean} true = allowed
 */
export function isAllowedByRules(parsed, path, userAgent = FS_USER_AGENT) {
  const ua = userAgent.toLowerCase();

  // Collect applicable rules: specific UA first, then wildcard '*'
  const specificRules = parsed.agentRules.get(ua) ?? [];
  const wildcardRules = parsed.agentRules.get('*') ?? [];
  const rules = specificRules.length > 0 ? specificRules : wildcardRules;

  if (rules.length === 0) return true; // no rules = allowed

  // Find matching rules, pick longest path (most specific)
  let bestRule = null;
  let bestLen  = -1;

  for (const rule of rules) {
    if (_pathMatches(rule.path, path)) {
      if (rule.path.length > bestLen) {
        bestLen  = rule.path.length;
        bestRule = rule;
      }
    }
  }

  return bestRule ? bestRule.allow : true;
}

/**
 * Fetch robots.txt for an origin (cached for 15 min).
 * @param {string} origin - e.g. 'https://example.com'
 * @returns {Promise<ParsedRobots|null>} null on fetch failure
 */
export async function fetchRobots(origin) {
  const cached = _cache.get(origin);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.rules;
  }

  const url = `${origin}/robots.txt`;
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 8000);
    const res  = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);

    if (res.status === 404) {
      // No robots.txt = everything allowed
      const empty = { agentRules: new Map(), crawlDelay: 0, sitemaps: [] };
      _cache.set(origin, { rules: empty, fetchedAt: Date.now() });
      return empty;
    }
    if (!res.ok) {
      logger.warn(MODULE, 'robots-fetch-fail', { origin, status: res.status });
      return null;
    }

    const text   = await res.text();
    const parsed = parseRobots(text);
    _cache.set(origin, { rules: parsed, fetchedAt: Date.now() });
    logger.info(MODULE, 'robots-fetched', { origin });
    return parsed;

  } catch (err) {
    logger.warn(MODULE, 'robots-fetch-error', { origin, error: err.message });
    return null;
  }
}

/**
 * High-level check: fetch robots.txt and check if path is allowed.
 * @param {string} origin
 * @param {string} path
 * @param {string} [userAgent]
 * @returns {Promise<{ allowed: boolean, crawlDelay: number, fetchError: boolean }>}
 */
export async function checkRobots(origin, path, userAgent = FS_USER_AGENT) {
  const parsed = await fetchRobots(origin);
  if (!parsed) {
    // Fetch error — be conservative, warn but don't block
    return { allowed: true, crawlDelay: 0, fetchError: true };
  }
  const allowed = isAllowedByRules(parsed, path, userAgent);
  return { allowed, crawlDelay: parsed.crawlDelay, fetchError: false };
}

// === END robots-parser.js ===
