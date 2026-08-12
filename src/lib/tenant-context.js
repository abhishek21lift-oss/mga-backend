'use strict';
// Per-request tenant context, carried across the async chain from the auth
// middleware down to db/pool.js — the plumbing TENANT-RLS-PLAN.md calls for
// so that 839 pool.query() call sites do not each need to be rewritten to
// pass an org id explicitly.
//
// AsyncLocalStorage rather than a request-scoped variable threaded through
// every function call: Express handlers, service functions and pool.query()
// are not all reachable through one call chain a plain argument could ride
// on, but they all run inside the same async context Node tracks for
// AsyncLocalStorage regardless of how many awaits sit between them.
//
// Dormant by construction: nothing calls runWithTenantContext except the
// auth middleware (behind TENANT_RLS_ENFORCE, see auth.js), and nothing
// reads currentOrgId except the pool.js query wrapper (behind the same
// flag). Requiring this module and never calling either function is a
// no-op.

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

/** Run `fn` with `orgId` available to currentOrgId() anywhere inside it. */
function runWithTenantContext(orgId, fn) {
  return als.run({ orgId }, fn);
}

/** The org id set by the innermost enclosing runWithTenantContext, or null
 *  outside of one (a background job, a script, a request that never set
 *  one — e.g. an unauthenticated route, since only auth.js calls in). */
function currentOrgId() {
  return als.getStore()?.orgId ?? null;
}

module.exports = { runWithTenantContext, currentOrgId };
