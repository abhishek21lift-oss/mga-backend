'use strict';
// Tenant-scope resolution for the multi-tenant data layer (Phase 1).
//
// Given an authenticated request, decide which organization's rows it may
// touch and whether an organization_id filter must be applied to queries.
//
// Rules (fail-closed):
//   - Platform super_admin, no target header → sees everything (no filter).
//   - Platform super_admin with `x-org-id`   → filtered to that org.
//   - Any tenant user                        → filtered to their own org.
//       A tenant user missing an org resolves to orgId=null, and since
//       `organization_id = NULL` matches no rows, they see NOTHING rather
//       than leaking across tenants.

function tenantScope(req) {
  const isSuperAdmin = req.user?.role === 'super_admin';
  const orgId = isSuperAdmin
    ? (req.headers['x-org-id'] || null)
    : (req.user?.organization_id || null);
  // Super admins operating platform-wide (no target) skip the filter;
  // everyone else — including super admins targeting a specific org, and
  // tenant users (even org-less ones, which then match no rows) — is filtered.
  const applyFilter = !isSuperAdmin || orgId !== null;
  return { isSuperAdmin, orgId, applyFilter };
}

// The org id to stamp onto rows this request creates.
function orgIdOf(req) {
  return tenantScope(req).orgId;
}

module.exports = { tenantScope, orgIdOf };
