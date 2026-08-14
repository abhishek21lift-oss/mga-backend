'use strict';
// Shared tenant guard for write paths that reference a client by id.
//
// Create/mutate handlers stamp new rows with the caller's org (orgIdOf), but
// that alone doesn't stop a caller from passing ANOTHER studio's client_id —
// the row would then land in the caller's org pointing at a foreign client
// (referential pollution, and a foothold for PII-copy bugs). Gate every such
// handler on this check so a foreign client_id is rejected outright.

const pool = require('../db/pool');
const { tenantScope } = require('./tenant-db');

// True when `clientId` belongs to the caller's org. A platform super admin
// operating platform-wide (no x-org-id) is unrestricted. A missing clientId
// passes (nothing to check — the caller isn't referencing a client).
async function clientInOrg(req, clientId) {
  if (!clientId) return true;
  const scope = tenantScope(req);
  if (!scope.applyFilter) return true;
  const { rowCount } = await pool.query(
    'SELECT 1 FROM pt_clients WHERE id = $1 AND deleted_at IS NULL AND organization_id = $2',
    [clientId, scope.orgId]
  );
  return rowCount > 0;
}

// True when `memberId` belongs to the caller's org. Same contract as
// clientInOrg above and for the same reason, against the members table that
// migration 166 created.
//
// This is not a duplicate of clientInOrg with a different table name, and the
// distinction is the whole point of the transformation: a PT client and a gym
// member are different people in different tables, one of which may exist
// without the other. Routing a member id through clientInOrg would look up a
// members UUID in pt_clients, find nothing, and reject every legitimate
// check-in — a guard that fails closed on valid input is still broken.
async function memberInOrg(req, memberId) {
  if (!memberId) return true;
  const scope = tenantScope(req);
  if (!scope.applyFilter) return true;
  const { rowCount } = await pool.query(
    'SELECT 1 FROM members WHERE id = $1 AND deleted_at IS NULL AND organization_id = $2',
    [memberId, scope.orgId]
  );
  return rowCount > 0;
}

module.exports = { clientInOrg, memberInOrg };
