// src/lib/features.js
//
// Feature resolution: given a studio, which capabilities are on?
//
// One function decides this — `resolveForOrg` — and everything else in the
// codebase asks it. Feature logic that gets reimplemented per call site drifts
// until the API says a feature is on and the UI hides it, or worse the other
// way round.
//
// Resolution order, most specific wins:
//
//   1. is_core            → always on. Not negotiable, not overridable.
//   2. global_enabled = F → off everywhere (the incident kill switch).
//   3. org override       → this studio's explicit setting, if unexpired.
//   4. plan grant         → only when the feature is_plan_gated.
//   5. default_enabled    → the catalogue default.
//
// The seeded state (everything enabled, nothing plan-gated) makes this return
// "on" for every feature and every studio, which is what is true today. See
// migration 123 for why that matters.
'use strict';

/** Why a feature ended up in the state it is in — shown to the operator. */
const SOURCE = {
  CORE: 'core',
  GLOBAL_OFF: 'global_off',
  OVERRIDE: 'override',
  PLAN: 'plan',
  DEFAULT: 'default',
};

// A single query rather than one per feature: the tenant-facing endpoint calls
// this on page load, and N round trips for N features would be the slowest
// thing on that path.
const RESOLVE_SQL = `
  SELECT f.key, f.name, f.description, f.category, f.is_core, f.is_plan_gated,
         f.global_enabled, f.default_enabled, f.sort_order,
         o.enabled     AS override_enabled,
         o.reason      AS override_reason,
         o.expires_at  AS override_expires_at,
         o.set_by_name AS override_set_by,
         -- An override past its expiry must not resolve, but must still be
         -- visible to the operator, so expiry is reported separately from the
         -- value rather than filtered out of the join.
         (o.organization_id IS NOT NULL
          AND (o.expires_at IS NULL OR o.expires_at > now())) AS override_active,
         pf.enabled    AS plan_enabled
    FROM platform_features f
    LEFT JOIN organization_features o
           ON o.feature_key = f.key AND o.organization_id = $1::uuid
    LEFT JOIN plan_features pf
           ON pf.feature_key = f.key AND pf.plan_code = $2
   ORDER BY f.sort_order, f.key`;

/**
 * Decide one feature's state from its already-joined row.
 * Split out from the query so the precedence rules are testable on their own —
 * they are the part that will be argued about, not the SQL.
 */
function decide(row) {
  if (row.is_core) return { enabled: true, source: SOURCE.CORE };
  if (row.global_enabled === false) return { enabled: false, source: SOURCE.GLOBAL_OFF };
  if (row.override_active) return { enabled: Boolean(row.override_enabled), source: SOURCE.OVERRIDE };
  if (row.is_plan_gated) {
    // No plan (a studio still on trial with no plan_code) falls through to the
    // catalogue default rather than resolving to false: a trialling studio
    // should see the product, not a wall of locked panels.
    if (row.plan_enabled !== null && row.plan_enabled !== undefined) {
      return { enabled: Boolean(row.plan_enabled), source: SOURCE.PLAN };
    }
  }
  return { enabled: Boolean(row.default_enabled), source: SOURCE.DEFAULT };
}

/**
 * Full resolution for one studio, with the reasoning attached.
 * @param {string} orgId
 * @param {string|null} planCode
 * @param {object} [client] pg client, for use inside a transaction
 * @returns {Promise<Array<object>>}
 */
async function resolveForOrg(orgId, planCode, client) {
  // Required lazily: db/pool.js exits the process when DATABASE_URL is unset,
  // and `decide` above is pure — the precedence rules must stay callable, and
  // testable, without a database anywhere near them.
  const db = client || require('../db/pool');
  const { rows } = await db.query(RESOLVE_SQL, [orgId, planCode || null]);
  return rows.map((r) => {
    const { enabled, source } = decide(r);
    return {
      key: r.key,
      name: r.name,
      description: r.description,
      category: r.category,
      enabled,
      source,
      is_core: r.is_core,
      is_plan_gated: r.is_plan_gated,
      override: r.override_enabled === null || r.override_enabled === undefined ? null : {
        enabled: r.override_enabled,
        reason: r.override_reason,
        expires_at: r.override_expires_at,
        set_by: r.override_set_by,
        active: r.override_active,
      },
    };
  });
}

/** The flat `{ key: boolean }` map a client actually renders from. */
async function mapForOrg(orgId, planCode, client) {
  const rows = await resolveForOrg(orgId, planCode, client);
  return Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
}

/** Is one feature on for one studio? */
async function isEnabled(orgId, planCode, key, client) {
  const rows = await resolveForOrg(orgId, planCode, client);
  const hit = rows.find((r) => r.key === key);
  // An unknown key resolves to TRUE. A typo in a guard must not silently lock
  // studios out of a working feature; the wrong failure here is a quiet outage,
  // and the registry is validated by the API when a key is actually written.
  return hit ? hit.enabled : true;
}

/**
 * Express guard. Deliberately NOT applied to any existing route.
 *
 * Wiring an existing Admin Studio route to a flag changes that studio's
 * behaviour, which is a product decision, not a side effect of building the
 * control plane. This exists so that when someone makes that decision, the
 * enforcement is one line and goes through the same resolver as everything
 * else — rather than being hand-rolled at each call site.
 *
 *   router.post('/generate', requireFeature('ai_suite'), handler)
 */
function requireFeature(key) {
  return async function featureGuard(req, res, next) {
    try {
      // Platform operators are not subject to tenant feature flags — they are
      // not inside a tenant.
      if (!req.user?.organization_id || req.user.role === 'super_admin') return next();
      const on = await isEnabled(req.user.organization_id, req.user.plan_code || null, key);
      if (on) return next();
      return res.status(403).json({
        error: { code: 'FEATURE_DISABLED', message: 'This feature is not enabled for your studio.', feature: key },
      });
    } catch (err) { return next(err); }
  };
}

module.exports = { SOURCE, RESOLVE_SQL, decide, resolveForOrg, mapForOrg, isEnabled, requireFeature };
