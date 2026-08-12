// src/lib/activityLog.js
// Shared fire-and-forget audit log helper. Extracted from src/routes/profile.js
// (previously a local copy there) so other modules (e.g. PAR-Q, workout gate)
// can log activity without duplicating this logic.
//
// organization_id and the optional oldData parameter were added for the
// business-write audit trail (client/payment/commission changes) — every
// existing caller passed only the first five arguments, so both are
// additive: a caller that never sends oldData gets exactly the row it got
// before, just with organization_id now stamped alongside it.
const pool = require('../db/pool');
const logger = require('../lib/logger');

/**
 * @param {object} req - the request; req.user.id/name/organization_id and
 *   req.ip/headers are read off it.
 * @param {string} action - e.g. 'client.update'.
 * @param {string} entityType - e.g. 'pt_client'.
 * @param {string} entityId
 * @param {unknown} [data] - stored as new_data.
 * @param {unknown} [oldData] - stored as old_data. Omit when there is no
 *   prior state worth the extra read to fetch it (a create, a delete where
 *   the id is enough) rather than passing an empty object for it.
 */
async function logActivity(req, action, entityType, entityId, data, oldData) {
  try {
    // Impersonation attribution: when a super-admin is acting inside a studio in
    // full (write) mode, the row is attributed to the studio admin (req.user),
    // so stamp who was really behind it into the JSONB payload. No schema change
    // — new_data is JSONB. Read-only sessions never reach a write, so this only
    // ever tags genuine full-access actions.
    let payload = data || null;
    if (req.impersonation) {
      payload = {
        ...(data || {}),
        _impersonated_by: req.impersonation.by || null,
        _impersonated_by_name: req.impersonation.byName || 'Admin',
      };
    }
    await pool.query(
      `INSERT INTO activity_log
        (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        req.user.id,
        req.user.name || null,
        action,
        entityType || 'profile',
        entityId || req.user.id,
        oldData ? JSON.stringify(oldData) : null,
        payload ? JSON.stringify(payload) : null,
        req.ip || null,
        req.headers['user-agent'] || null,
        req.user.organization_id || null,
      ]
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'activity log failed');
  }
}

module.exports = { logActivity };
