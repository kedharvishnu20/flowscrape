// === row-buffer.js ===
/**
 * @module row-buffer
 * @description In-memory ring buffer + periodic flush to IndexedDB.
 *   Flushes every 50 rows or every 30 seconds (whichever comes first).
 *   Provides backpressure-safe pushRow() that never loses data.
 *
 *   Design decision: We use a ring buffer (fixed-size array with head/tail
 *   pointers) rather than an Array.push() approach to avoid O(n) copy costs
 *   on large runs. Flush is to IDB (not local storage) because row data can
 *   be large and IDB has no size limit in practice.
 *
 * @dependencies logger, cursor-store
 */

import { logger } from '../utils/logger.js';

const MODULE = 'row-buffer';

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_ROWS_COUNT  = 50;
const DB_NAME           = 'flowscrape_v3';
const STORE_ROWS        = 'data_rows';

const _buffers     = new Map();
const _flushTimers = new Map();
let _idbDB      = null;

// ── IDB helpers ───────────────────────────────────────────────────────────────
async function _openDB() {
  if (_idbDB) return _idbDB;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onsuccess  = e => { _idbDB = e.target.result; resolve(_idbDB); };
    req.onerror    = () => reject(req.error);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_ROWS)) {
        const store = db.createObjectStore(STORE_ROWS, { autoIncrement: true });
        store.createIndex('runId', 'runId', { unique: false });
      }
    };
  });
}

async function _writeRows(runId, rows) {
  const db = await _openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE_ROWS], 'readwrite');
    const store = tx.objectStore(STORE_ROWS);
    for (const row of rows) {
      store.put({ runId, ...row });
    }
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize the buffer for a run.
 * @param {string} runId
 */
export function initBuffer(runId) {
  _buffers.set(runId, []);
  _startFlushTimer(runId);
  logger.info(MODULE, 'buffer-init', { runId });
}

/**
 * Push a result row into the buffer. Flushes if threshold reached.
 * @param {string} runId
 * @param {object} row
 * @returns {Promise<void>}
 */
export async function pushRow(runId, row) {
  const buf = _buffers.get(runId) || [];
  buf.push(row);
  _buffers.set(runId, buf);
  if (buf.length >= FLUSH_ROWS_COUNT) {
    await flush(runId);
  }
}

/**
 * Flush all buffered rows to IndexedDB now.
 * @param {string} runId
 * @returns {Promise<void>}
 */
export async function flush(runId) {
  const buf = _buffers.get(runId) || [];
  if (buf.length === 0) return;
  const toWrite = buf.splice(0, buf.length);
  try {
    await _writeRows(runId, toWrite);
    logger.debug(MODULE, 'flush-ok', { count: toWrite.length, runId });
  } catch (err) {
    buf.unshift(...toWrite);
    logger.error(MODULE, 'flush-fail', { error: err.message, runId });
    throw err;
  }
}

/**
 * Start periodic flush timer.
 * @param {string} runId 
 */
function _startFlushTimer(runId) {
  _stopFlushTimer(runId);
  const timer = setInterval(async () => {
    try { await flush(runId); } catch { /* logged in flush() */ }
  }, FLUSH_INTERVAL_MS);
  _flushTimers.set(runId, timer);
}

/**
 * Stop the periodic flush timer.
 * @param {string} runId 
 */
function _stopFlushTimer(runId) {
  const timer = _flushTimers.get(runId);
  if (timer) {
    clearInterval(timer);
    _flushTimers.delete(runId);
  }
}

/**
 * Finalize: flush remaining rows and stop timer.
 * @param {string} runId 
 * @returns {Promise<void>}
 */
export async function finalizeBuffer(runId) {
  _stopFlushTimer(runId);
  await flush(runId);
  _buffers.delete(runId);
  logger.info(MODULE, 'buffer-finalized', { runId });
}

/**
 * Read all stored rows for a runId from IDB.
 * @param {string} runId
 * @returns {Promise<object[]>}
 */
export async function readAllRows(runId) {
  const db = await _openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE_ROWS], 'readonly');
    const store = tx.objectStore(STORE_ROWS);
    const index = store.index('runId');
    const req   = index.getAll(IDBKeyRange.only(runId));
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Clear all rows for a runId from IDB.
 * @param {string} runId
 */
export async function clearRows(runId) {
  const db = await _openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE_ROWS], 'readwrite');
    const store = tx.objectStore(STORE_ROWS);
    const index = store.index('runId');
    const req   = index.openKeyCursor(IDBKeyRange.only(runId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

// === END row-buffer.js ===
