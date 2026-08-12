'use strict';
// Feature flags and per-studio overrides — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  pool,
} = require('./shared');
const features = require('../../../lib/features');

const OVERRIDE_REASON_MAX = 500;

/** A studio's plan is needed to resolve plan-gated features. */
async function loadOrgForFeatures(id) {
  const { rows } = await pool.query('SELECT id, name, plan_code FROM organizations WHERE id = $1', [id]);
  return rows[0] || null;
}

// ── GET /features ────────────────────────────────────────────────────────────
// The catalogue, the plan matrix, and how many studios override each feature.
// The override count is what tells an operator that flipping a global switch is
// about to collide with deliberate per-studio decisions.
router.get('/features', async (req, res, next) => {
  try {
    const [cat, plans, matrix] = await Promise.all([
      pool.query(`
        SELECT f.*,
               (SELECT count(*) FROM organization_features o
                 WHERE o.feature_key = f.key
                   AND (o.expires_at IS NULL OR o.expires_at > now()))::int AS override_count,
               (SELECT count(*) FROM organization_features o
                 WHERE o.feature_key = f.key AND o.enabled = FALSE
                   AND (o.expires_at IS NULL OR o.expires_at > now()))::int AS disabled_count
          FROM platform_features f
         ORDER BY f.sort_order, f.key`),
      pool.query('SELECT code, name, sort_order FROM subscription_plans ORDER BY sort_order, code'),
      pool.query('SELECT plan_code, feature_key, enabled FROM plan_features'),
    ]);

    // Shaped as plan → feature → boolean, which is how the UI draws the grid.
    const plan_matrix = {};
    for (const p of plans.rows) plan_matrix[p.code] = {};
    for (const r of matrix.rows) {
      if (!plan_matrix[r.plan_code]) plan_matrix[r.plan_code] = {};
      plan_matrix[r.plan_code][r.feature_key] = r.enabled;
    }

    res.json({ data: { features: cat.rows, plans: plans.rows, plan_matrix } });
  } catch (err) { next(err); }
});

// ── PATCH /features/:key ─────────────────────────────────────────────────────
// The three platform-level switches. is_core is not among them: it is a
// property of the product, not a setting, and the schema rejects a core
// feature that is off anyway.
router.patch('/features/:key', async (req, res, next) => {
  try {
    const { rows: [before] } = await pool.query('SELECT * FROM platform_features WHERE key = $1', [req.params.key]);
    if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown feature' } });
    if (before.is_core) {
      return res.status(400).json({ error: { code: 'CORE_FEATURE', message: `${before.name} is core to the product and cannot be changed.` } });
    }

    const patch = {};
    for (const f of ['global_enabled', 'default_enabled', 'is_plan_gated']) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) patch[f] = Boolean(req.body[f]);
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'No fields to update' } });
    }

    const cols = Object.keys(patch);
    const { rows } = await pool.query(
      `UPDATE platform_features SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
        WHERE key = $1 RETURNING *`,
      [req.params.key, ...cols.map((c) => patch[c])]
    );

    // How many studios this actually reaches, recorded at the moment of the
    // change: "turned off the AI Suite" means something different against 3
    // studios than against 300, and the count is not recoverable later.
    const { rows: [reach] } = await pool.query(
      `SELECT count(*)::int AS studios FROM organizations WHERE status <> 'deleted'`
    );

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'feature_updated','platform_feature',$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.user?.name || null, req.params.key,
       { global_enabled: before.global_enabled, default_enabled: before.default_enabled, is_plan_gated: before.is_plan_gated },
       { ...patch, studios_affected: reach.studios },
       req.ip || null, req.get('user-agent') || null]
    );

    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PUT /features/:key/plans ─────────────────────────────────────────────────
// Which plans include this feature. Body: { plans: { starter: false, ... } }.
router.put('/features/:key/plans', async (req, res, next) => {
  try {
    const { rows: [feature] } = await pool.query('SELECT * FROM platform_features WHERE key = $1', [req.params.key]);
    if (!feature) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown feature' } });
    if (feature.is_core) {
      return res.status(400).json({ error: { code: 'CORE_FEATURE', message: `${feature.name} is core to the product and is included in every plan.` } });
    }

    const wanted = req.body?.plans;
    if (!wanted || typeof wanted !== 'object' || Array.isArray(wanted)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'plans must be an object of { plan_code: boolean }' } });
    }

    const { rows: validPlans } = await pool.query('SELECT code FROM subscription_plans');
    const valid = new Set(validPlans.map((p) => p.code));
    const unknown = Object.keys(wanted).filter((c) => !valid.has(c));
    if (unknown.length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Unknown plan(s): ${unknown.join(', ')}` } });
    }

    const { rows: before } = await pool.query(
      'SELECT plan_code, enabled FROM plan_features WHERE feature_key = $1', [req.params.key]
    );

    for (const [code, enabled] of Object.entries(wanted)) {
      await pool.query(
        `INSERT INTO plan_features (plan_code, feature_key, enabled)
         VALUES ($1,$2,$3)
         ON CONFLICT (plan_code, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [code, req.params.key, Boolean(enabled)]
      );
    }

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'feature_plans_updated','platform_feature',$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.user?.name || null, req.params.key,
       Object.fromEntries(before.map((r) => [r.plan_code, r.enabled])), wanted,
       req.ip || null, req.get('user-agent') || null]
    );

    const { rows } = await pool.query(
      'SELECT plan_code, feature_key, enabled FROM plan_features WHERE feature_key = $1', [req.params.key]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /organizations/:id/features ──────────────────────────────────────────
// One studio's resolved state, with the reason for each — the view an operator
// needs when a studio reports that something has vanished.
router.get('/organizations/:id/features', async (req, res, next) => {
  try {
    const org = await loadOrgForFeatures(req.params.id);
    if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });
    res.json({ data: await features.resolveForOrg(org.id, org.plan_code) });
  } catch (err) { next(err); }
});

// ── PUT /organizations/:id/features/:key ─────────────────────────────────────
// Set an override. A reason is required: an unexplained flag on one studio is
// indistinguishable from a mistake six months later, and the operator who set
// it will not be the one reading it.
router.put('/organizations/:id/features/:key', async (req, res, next) => {
  try {
    const org = await loadOrgForFeatures(req.params.id);
    if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });

    const { rows: [feature] } = await pool.query('SELECT * FROM platform_features WHERE key = $1', [req.params.key]);
    if (!feature) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown feature' } });
    if (feature.is_core) {
      return res.status(400).json({ error: { code: 'CORE_FEATURE', message: `${feature.name} is core to the product and cannot be switched off.` } });
    }

    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'enabled must be true or false' } });
    }
    const reason = String(req.body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A reason is required for a per-studio override.' } });
    }
    if (reason.length > OVERRIDE_REASON_MAX) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Reason must be ${OVERRIDE_REASON_MAX} characters or fewer.` } });
    }

    let expiresAt = null;
    if (req.body.expires_at) {
      const d = new Date(req.body.expires_at);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'expires_at is not a valid date' } });
      }
      if (d.getTime() <= Date.now()) {
        // An override that is already expired does nothing, so accepting it
        // would silently produce a no-op the operator believes worked.
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'expires_at must be in the future' } });
      }
      expiresAt = d.toISOString();
    }

    const { rows: [before] } = await pool.query(
      'SELECT enabled, reason, expires_at FROM organization_features WHERE organization_id = $1 AND feature_key = $2',
      [org.id, req.params.key]
    );

    const { rows } = await pool.query(
      `INSERT INTO organization_features
         (organization_id, feature_key, enabled, reason, expires_at, set_by, set_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (organization_id, feature_key) DO UPDATE
         SET enabled = EXCLUDED.enabled, reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at,
             set_by = EXCLUDED.set_by, set_by_name = EXCLUDED.set_by_name, updated_at = now()
       RETURNING *`,
      [org.id, req.params.key, req.body.enabled, reason, expiresAt,
       req.user?.id || null, req.user?.name || null]
    );

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'feature_override_set','organization',$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.user?.name || null, org.id,
       before || null,
       { feature: req.params.key, enabled: req.body.enabled, reason, expires_at: expiresAt, studio: org.name },
       req.ip || null, req.get('user-agent') || null]
    );

    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /organizations/:id/features/:key ──────────────────────────────────
// Clear the override so the studio falls back to its plan / the default.
router.delete('/organizations/:id/features/:key', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM organization_features WHERE organization_id = $1 AND feature_key = $2 RETURNING *',
      [req.params.id, req.params.key]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No override set' } });

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'feature_override_cleared','organization',$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.user?.name || null, req.params.id,
       { enabled: rows[0].enabled, reason: rows[0].reason, expires_at: rows[0].expires_at },
       { feature: req.params.key },
       req.ip || null, req.get('user-agent') || null]
    );

    res.json({ data: { cleared: true, feature: req.params.key } });
  } catch (err) { next(err); }
});

// ── GET /features/:key/overrides ─────────────────────────────────────────────
// Every studio that deviates from the default for one feature — the answer to
// "who is this switch actually going to affect".
router.get('/features/:key/overrides', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, org.name AS organization_name, org.slug AS organization_slug, org.plan_code
         FROM organization_features o
         JOIN organizations org ON org.id = o.organization_id
        WHERE o.feature_key = $1
        ORDER BY o.updated_at DESC`,
      [req.params.key]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  NOTIFICATION CENTRE
//
//  Announcements from the platform to its studios: maintenance windows, new
//  features, policy changes, billing deadlines.
//
//  Delivery lands in the studio's existing notification bell — no Admin Studio
//  code changes to make that work (see lib/announcements.js for why fan-out).
//
//  Sending is the only irreversible action in the Control Centre, so the shape
//  of this API is: draft freely, preview exactly what will go out, then send
//  once. Editing a sent announcement is refused rather than silently ignored.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = router;
