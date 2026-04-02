// === cursor-store.js ===
/**
 * @module cursor-store
 * @description IndexedDB cursor read/write for checkpoint/resume.
 *   Stores the pipeline run position (row index, step index, runId) so that
 *   an interrupted run can be resumed from the last saved cursor.
 *
 *   Design decision: We use IndexedDB (not session/local storage) because
 *   cursor data may be large and needs to survive SW restarts. IDB is the
 *   correct tier for structured run-state data per the storage architecture.
 *
 * @dependencies logger
 */

import { logger } from '../utils/logger.js';

const MODULE    = 'cursor-store';
const DB_NAME   = 'flowscrape_v3';
const DB_VERSION = 1;
const STORE_CURSORS = 'cursors';

/** @type {IDBDatabase|null} */
let _db = null;

/**
 * Open (or reuse) the IDB database.
 * @returns {Promise<IDBDatabase>}
 */
async function _openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_CURSORS)) {
        db.createObjectStore(STORE_CURSORS, { keyPath: 'runId' });
      }
      if (!db.objectStoreNames.contains('row_buffer')) {
        db.createObjectStore('row_buffer', { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('data_rows')) {
        const store = db.createObjectStore('data_rows', { autoIncrement: true });
        store.createIndex('runId', 'runId', { unique: false });
      }
    };
    req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror    = () => reject(req.error);
  });
}

/**
 * Run a transaction and return a Promise.
 * @param {string[]} storeNames
 * @param {'readonly'|'readwrite'} mode
 * @param {function(IDBTransaction): Promise<any>} fn
 */
async function _tx(storeNames, mode, fn) {
  const db = await _openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map(s => [s, tx.objectStore(s)]));
    tx.onerror   = () => reject(tx.error);
    fn(stores).then(resolve).catch(reject);
  });
}

/**
 * @typedef {Object} Cursor
 * @property {string} runId
 * @property {number} rowIndex   - Last successfully processed row (0-based)
 * @property {number} stepIndex  - Current step index
 * @property {string} savedAt    - ISO8601
 * @property {object} [extra]    - Any extra pipeline-specific state
 */

/**
 * Save a cursor to IDB.
 * @param {Cursor} cursor
 */
export async function saveCursor(cursor) {
  try {
    await _tx([STORE_CURSORS], 'readwrite', async ({ [STORE_CURSORS]: store }) => {
      return new Promise((resolve, reject) => {
        const req = store.put({ ...cursor, savedAt: new Date().toISOString() });
        req.onsuccess = resolve;
        req.onerror   = () => reject(req.error);
      });
    });
    logger.debug(MODULE, 'cursor-saved', { runId: cursor.runId, rowIndex: cursor.rowIndex });
  } catch (err) {
    logger.error(MODULE, 'cursor-save-fail', { error: err.message });
    throw err;
  }
}

/**
 * Load a cursor by runId.
 * @param {string} runId
 * @returns {Promise<Cursor|null>}
 */
export async function loadCursor(runId) {
  try {
    return await _tx([STORE_CURSORS], 'readonly', ({ [STORE_CURSORS]: store }) => {
      return new Promise((resolve, reject) => {
        const req = store.get(runId);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => reject(req.error);
      });
    });
  } catch (err) {
    logger.error(MODULE, 'cursor-load-fail', { error: err.message });
    return null;
  }
}

/**
 * List all stored cursors (incomplete runs).
 * @returns {Promise<Cursor[]>}
 */
export async function listCursors() {
  try {
    return await _tx([STORE_CURSORS], 'readonly', ({ [STORE_CURSORS]: store }) => {
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result ?? []);
        req.onerror   = () => reject(req.error);
      });
    });
  } catch (err) {
    logger.error(MODULE, 'cursor-list-fail', { error: err.message });
    return [];
  }
}

/**
 * Delete a cursor (called on run completion).
 * @param {string} runId
 */
export async function deleteCursor(runId) {
  try {
    await _tx([STORE_CURSORS], 'readwrite', ({ [STORE_CURSORS]: store }) => {
      return new Promise((resolve, reject) => {
        const req = store.delete(runId);
        req.onsuccess = resolve;
        req.onerror   = () => reject(req.error);
      });
    });
    logger.info(MODULE, 'cursor-deleted', { runId });
  } catch (err) {
    logger.error(MODULE, 'cursor-delete-fail', { error: err.message });
  }
}

// === END cursor-store.js ===
