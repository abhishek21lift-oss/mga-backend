// src/lib/storageLedger.js
//
// Records what was written to object storage, so bytes can be attributed to a
// studio. Object keys carry no studio, so this is the only place attribution
// can happen — see migration 128.
//
// ── The one rule ─────────────────────────────────────────────────────────────
//
// RECORDING MUST NEVER BREAK AN UPLOAD. Every function swallows its own errors
// and none is awaited by fileStorage.saveFile. A studio losing the ability to
// upload a signed consent form because a metrics table was locked would be a
// far worse outcome than a missing row. Same posture as lib/loginEvents.js.
'use strict';

const logger = require('./logger');

/**
 * Record (or replace) an object.
 *
 * Upserts on key: writing the same key twice replaces the object in R2, so the
 * row is replaced rather than double-counted. It also clears deleted_at, since
 * re-writing a previously deleted key means it exists again.
 *
 * Fire-and-forget — callers do not await it.
 *
 * @param {object} o
 * @param {string} o.key           the storage key, e.g. "parq/pdf/<id>.pdf"
 * @param {number} o.bytes
 * @param {string} o.category
 * @param {string} [o.contentType]
 * @param {string} [o.organizationId] null when the call site has no studio
 * @param {string} [o.uploadedBy]
 * @param {object} [client] injectable query runner; tests pass one so the
 *   normalisation below can be exercised without a pool.
 * @returns {Promise} already-caught, so awaiting it can never reject.
 */
function record(o, client) {
  let pool = client;
  if (!pool) { try { pool = require('../db/pool'); } catch { return; } }

  return pool.query(
    `INSERT INTO storage_objects
       (key, organization_id, category, bytes, content_type, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (key) DO UPDATE
       SET organization_id = COALESCE(EXCLUDED.organization_id, storage_objects.organization_id),
           bytes = EXCLUDED.bytes,
           content_type = EXCLUDED.content_type,
           updated_at = now(),
           deleted_at = NULL`,
    [
      o.key,
      o.organizationId || null,
      o.category || 'unknown',
      Number.isFinite(Number(o.bytes)) ? Math.max(0, Math.trunc(Number(o.bytes))) : 0,
      o.contentType || null,
      o.uploadedBy || null,
    ]
  ).catch((err) => {
    logger.warn({ err: err.message, key: o.key }, 'storage ledger write failed (non-critical)');
  });
}

/**
 * Mark an object gone. Soft, so "how much has this studio ever uploaded" stays
 * answerable after a purge while live usage counts only undeleted rows.
 */
function recordDelete(key, client) {
  let pool = client;
  if (!pool) { try { pool = require('../db/pool'); } catch { return; } }

  return pool.query(
    'UPDATE storage_objects SET deleted_at = now() WHERE key = $1 AND deleted_at IS NULL',
    [key]
  ).catch((err) => {
    logger.warn({ err: err.message, key }, 'storage ledger delete failed (non-critical)');
  });
}

module.exports = { record, recordDelete };
