'use strict';
// AI usage, pricing and model routing — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  audit, pool,
} = require('./shared');
const aiQuota = require('../../../lib/aiQuota');
const aiSettings = require('../../../lib/ai/settings');
const { models: aiModels, DEFAULTS: AI_DEFAULTS } = require('../../../lib/ai/models');

const AI_MAX_DAYS = 365;
function aiDays(v, dflt = 30) {
  const n = Number(v);
  if (!Number.isFinite(n) || String(v ?? '').trim() === '') return dflt;
  return Math.min(Math.max(Math.trunc(n), 1), AI_MAX_DAYS);
}

// Cost in rupees for a row's tokens, given the rate table. LEFT JOIN so an
// unpriced model still contributes its tokens; COALESCE(...,0) on the rate
// means it contributes zero cost rather than dropping the row to NULL.
const COST_SQL = `
  (COALESCE(r.prompt_per_1k_inr, 0)     * l.tokens_prompt     / 1000.0
 + COALESCE(r.completion_per_1k_inr, 0) * l.tokens_completion / 1000.0)`;

// ── GET /ai/overview ─────────────────────────────────────────────────────────
router.get('/ai/overview', async (req, res, next) => {
  try {
    const days = aiDays(req.query.days);
    const [totals, unpriced, settings] = await Promise.all([
      pool.query(
        `SELECT count(*)::int                                   AS requests,
                COALESCE(SUM(l.tokens_total), 0)::bigint         AS tokens,
                COALESCE(SUM(l.tokens_prompt), 0)::bigint        AS tokens_prompt,
                COALESCE(SUM(l.tokens_completion), 0)::bigint    AS tokens_completion,
                count(DISTINCT u.organization_id)::int           AS studios,
                count(DISTINCT l.user_id)::int                   AS users,
                COALESCE(ROUND(AVG(NULLIF(l.latency_ms, 0)))::int, 0) AS avg_latency_ms,
                -- A fallback means the primary provider failed. A rising rate
                -- is an availability problem, not a usage one, so it is
                -- surfaced next to the volume rather than buried.
                count(*) FILTER (WHERE l.used_fallback)::int     AS fallbacks,
                COALESCE(SUM(${COST_SQL}), 0)::numeric           AS cost_inr
           FROM ai_usage_log l
           LEFT JOIN users u ON u.id = l.user_id
           LEFT JOIN ai_model_rates r ON r.model = l.model
          WHERE l.created_at >= now() - ($1 || ' days')::interval`,
        [String(days)]
      ),
      pool.query(
        `SELECT DISTINCT l.model
           FROM ai_usage_log l
           LEFT JOIN ai_model_rates r ON r.model = l.model
          WHERE l.created_at >= now() - ($1 || ' days')::interval
            AND l.model IS NOT NULL
            AND (r.model IS NULL OR (r.prompt_per_1k_inr = 0 AND r.completion_per_1k_inr = 0))
          ORDER BY 1`,
        [String(days)]
      ),
      aiQuota.loadSettings(),
    ]);

    const t = totals.rows[0];
    res.json({
      data: {
        window_days: days,
        ...t,
        tokens: Number(t.tokens),
        tokens_prompt: Number(t.tokens_prompt),
        tokens_completion: Number(t.tokens_completion),
        cost_inr: Number(t.cost_inr),
        fallback_pct: t.requests ? Math.round((t.fallbacks / t.requests) * 1000) / 10 : 0,
        // The honesty valve: a non-empty list means cost_inr is a floor, not a
        // total, and the UI is expected to say so.
        unpriced_models: unpriced.rows.map((r) => r.model),
        enforcement_enabled: settings.enforcement_enabled,
        default_monthly_tokens: settings.default_monthly_tokens === null
          ? null : Number(settings.default_monthly_tokens),
      },
    });
  } catch (err) { next(err); }
});

// ── GET /ai/by-studio ────────────────────────────────────────────────────────
// Ranked by tokens, with each studio's allowance beside its usage — the two
// numbers an operator compares are useless apart.
router.get('/ai/by-studio', async (req, res, next) => {
  try {
    const days = aiDays(req.query.days);
    const { rows } = await pool.query(
      `WITH usage AS (
         SELECT u.organization_id,
                count(*)::int                                AS requests,
                COALESCE(SUM(l.tokens_total), 0)::bigint      AS tokens,
                COALESCE(SUM(${COST_SQL}), 0)::numeric        AS cost_inr,
                max(l.created_at)                             AS last_used_at,
                -- Usage inside the current calendar month is what a monthly
                -- allowance is measured against; the window above may be
                -- longer or shorter and must not be compared to the limit.
                COALESCE(SUM(l.tokens_total)
                  FILTER (WHERE l.created_at >= ${aiQuota.PERIOD_SQL}), 0)::bigint AS tokens_this_month
           FROM ai_usage_log l
           JOIN users u ON u.id = l.user_id
           LEFT JOIN ai_model_rates r ON r.model = l.model
          WHERE l.created_at >= now() - ($1 || ' days')::interval
            AND u.organization_id IS NOT NULL
          GROUP BY u.organization_id
       )
       SELECT o.id AS organization_id, o.name AS organization_name, o.plan_code,
              usage.requests, usage.tokens::bigint, usage.cost_inr,
              usage.tokens_this_month::bigint, usage.last_used_at,
              lim.monthly_tokens, (lim.organization_id IS NOT NULL) AS has_own_limit
         FROM usage
         JOIN organizations o ON o.id = usage.organization_id
         LEFT JOIN organization_ai_limits lim ON lim.organization_id = o.id
        WHERE o.status <> 'deleted'
        ORDER BY usage.tokens DESC
        LIMIT 200`,
      [String(days)]
    );

    const settings = await aiQuota.loadSettings();
    const dflt = settings.default_monthly_tokens === null ? null : Number(settings.default_monthly_tokens);

    res.json({
      data: rows.map((r) => {
        // Mirrors lib/aiQuota.limitFor: an existing row wins even when NULL,
        // because that is an operator exempting the studio.
        const limit = r.has_own_limit
          ? (r.monthly_tokens === null ? null : Number(r.monthly_tokens))
          : dflt;
        const used = Number(r.tokens_this_month);
        return {
          ...r,
          tokens: Number(r.tokens),
          tokens_this_month: used,
          cost_inr: Number(r.cost_inr),
          limit,
          limit_source: r.has_own_limit ? 'studio' : (dflt === null ? 'none' : 'default'),
          used_pct: limit ? Math.round((used / limit) * 1000) / 10 : null,
          over: limit !== null && used >= limit,
        };
      }),
    });
  } catch (err) { next(err); }
});

// ── GET /ai/by-model ─────────────────────────────────────────────────────────
router.get('/ai/by-model', async (req, res, next) => {
  try {
    const days = aiDays(req.query.days);
    const { rows } = await pool.query(
      `SELECT l.model, l.provider,
              count(*)::int                              AS requests,
              COALESCE(SUM(l.tokens_total), 0)::bigint    AS tokens,
              COALESCE(SUM(${COST_SQL}), 0)::numeric      AS cost_inr,
              COALESCE(ROUND(AVG(NULLIF(l.latency_ms, 0)))::int, 0) AS avg_latency_ms,
              count(*) FILTER (WHERE l.used_fallback)::int AS fallbacks,
              (r.model IS NOT NULL AND (r.prompt_per_1k_inr > 0 OR r.completion_per_1k_inr > 0)) AS priced
         FROM ai_usage_log l
         LEFT JOIN ai_model_rates r ON r.model = l.model
        WHERE l.created_at >= now() - ($1 || ' days')::interval
        GROUP BY l.model, l.provider, r.model, r.prompt_per_1k_inr, r.completion_per_1k_inr
        ORDER BY 4 DESC`,
      [String(days)]
    );
    res.json({
      data: rows.map((r) => ({ ...r, tokens: Number(r.tokens), cost_inr: Number(r.cost_inr) })),
    });
  } catch (err) { next(err); }
});

// ── GET /ai/trend ────────────────────────────────────────────────────────────
// Daily series on a continuous date spine, so a day with no AI use renders as
// a zero instead of vanishing and flattening the trend.
router.get('/ai/trend', async (req, res, next) => {
  try {
    const days = aiDays(req.query.days);
    const { rows } = await pool.query(
      `WITH spine AS (
         SELECT generate_series(
           date_trunc('day', now()) - (($1::int - 1) || ' days')::interval,
           date_trunc('day', now()), '1 day'
         )::date AS day
       ),
       u AS (
         SELECT date_trunc('day', l.created_at)::date AS day,
                count(*)::int AS requests,
                COALESCE(SUM(l.tokens_total), 0)::bigint AS tokens,
                COALESCE(SUM(${COST_SQL}), 0)::numeric AS cost_inr
           FROM ai_usage_log l
           LEFT JOIN ai_model_rates r ON r.model = l.model
          WHERE l.created_at >= date_trunc('day', now()) - (($1::int - 1) || ' days')::interval
          GROUP BY 1
       )
       SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
              COALESCE(u.requests, 0) AS requests,
              COALESCE(u.tokens, 0)::bigint AS tokens,
              COALESCE(u.cost_inr, 0)::numeric AS cost_inr
         FROM spine s LEFT JOIN u ON u.day = s.day
        ORDER BY s.day`,
      [days]
    );
    res.json({ data: rows.map((r) => ({ ...r, tokens: Number(r.tokens), cost_inr: Number(r.cost_inr) })) });
  } catch (err) { next(err); }
});

// ── GET|PUT /ai/settings ─────────────────────────────────────────────────────
router.get('/ai/settings', async (req, res, next) => {
  try {
    const [settings, rates] = await Promise.all([
      aiQuota.loadSettings(),
      pool.query('SELECT * FROM ai_model_rates ORDER BY model'),
    ]);
    res.json({ data: { ...settings, rates: rates.rows } });
  } catch (err) { next(err); }
});

router.put('/ai/settings', async (req, res, next) => {
  try {
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'enforcement_enabled')) {
      patch.enforcement_enabled = Boolean(req.body.enforcement_enabled);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'default_monthly_tokens')) {
      const v = req.body.default_monthly_tokens;
      // null is meaningful — it clears the platform default back to unlimited.
      if (v === null || v === '') patch.default_monthly_tokens = null;
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: { code: 'VALIDATION', message: 'default_monthly_tokens must be a non-negative number or null' } });
        }
        patch.default_monthly_tokens = Math.trunc(n);
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'warn_at_pct')) {
      const n = Number(req.body.warn_at_pct);
      if (!Number.isFinite(n) || n <= 0 || n > 100) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'warn_at_pct must be between 1 and 100' } });
      }
      patch.warn_at_pct = Math.trunc(n);
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'No fields to update' } });
    }

    const before = await aiQuota.loadSettings();
    const cols = Object.keys(patch);
    const { rows } = await pool.query(
      `UPDATE ai_platform_settings
          SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now(), updated_by = $${cols.length + 1}
        WHERE id = TRUE RETURNING *`,
      [...cols.map((c) => patch[c]), req.user?.name || null]
    );

    // Switching enforcement on is the consequential one — it can start
    // refusing requests — so how many studios are already over is recorded
    // with it, not left to be reconstructed afterwards.
    let wouldBlock = null;
    if (patch.enforcement_enabled === true) {
      const { rows: over } = await pool.query(
        `SELECT count(*)::int AS n FROM (
           SELECT u.organization_id, SUM(l.tokens_total) AS used
             FROM ai_usage_log l JOIN users u ON u.id = l.user_id
            WHERE l.created_at >= ${aiQuota.PERIOD_SQL} AND u.organization_id IS NOT NULL
            GROUP BY u.organization_id
         ) s
         LEFT JOIN organization_ai_limits lim ON lim.organization_id = s.organization_id
        WHERE COALESCE(lim.monthly_tokens, $1::bigint) IS NOT NULL
          AND s.used >= COALESCE(lim.monthly_tokens, $1::bigint)`,
        [rows[0].default_monthly_tokens]
      );
      wouldBlock = over[0].n;
    }

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'ai_settings_updated','ai_platform',NULL,$3,$4,$5,$6)`,
      [req.user?.id || null, req.user?.name || null,
       { enforcement_enabled: before.enforcement_enabled, default_monthly_tokens: before.default_monthly_tokens },
       { ...patch, ...(wouldBlock !== null ? { studios_already_over: wouldBlock } : {}) },
       req.ip || null, req.get('user-agent') || null]
    );

    res.json({ data: rows[0], studios_already_over: wouldBlock });
  } catch (err) { next(err); }
});

// ── PUT /ai/rates/:model ─────────────────────────────────────────────────────
router.put('/ai/rates/:model', async (req, res, next) => {
  try {
    const prompt = Number(req.body?.prompt_per_1k_inr ?? 0);
    const completion = Number(req.body?.completion_per_1k_inr ?? 0);
    if (![prompt, completion].every((n) => Number.isFinite(n) && n >= 0)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Rates must be non-negative numbers' } });
    }

    const { rows } = await pool.query(
      `INSERT INTO ai_model_rates (model, provider, prompt_per_1k_inr, completion_per_1k_inr, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (model) DO UPDATE
         SET provider = EXCLUDED.provider, prompt_per_1k_inr = EXCLUDED.prompt_per_1k_inr,
             completion_per_1k_inr = EXCLUDED.completion_per_1k_inr,
             updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [req.params.model, req.body?.provider || null, prompt, completion, req.user?.name || null]
    );

    await audit(req, 'ai_rate_updated', 'ai_model_rate', req.params.model,
      { prompt_per_1k_inr: prompt, completion_per_1k_inr: completion });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET|PUT /ai/routing ──────────────────────────────────────────────────────
//
// Which MODEL each tier resolves to. Deliberately a separate endpoint from
// /ai/settings, which governs quota enforcement and cost rates: those decide
// how much a studio may spend, this decides what it spends it on. Folding them
// into one payload would mean an operator adjusting a token allowance and an
// operator swapping a deprecated model share a request shape, an audit action
// and a blast radius, when only one of them can take the whole platform down.
//
// Tiers come from environment variables today (AI_PRIMARY_MODEL and friends),
// which was right — it kept model names out of the source — but it makes
// changing one a Render edit plus a redeploy. When a provider deprecates a
// model mid-afternoon that is the wrong shape of operation.
//
// An empty override means "follow the environment variable", which is what
// every deploy starts as, so this endpoint existing changes nothing until an
// operator sets a value. See lib/ai/settings.js for why a database outage
// cannot alter routing either.

// A model id is an opaque provider string ("vendor/model:tag"). We cannot
// check that it exists — only the provider knows — but we can refuse the
// shapes that are certainly wrong, so a typo fails here rather than turning
// into a run of provider 400s on live traffic with no obvious cause.
const MODEL_ID_RE = /^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/;

function readModelField(body, key) {
  const raw = body[key];
  // undefined = "leave this tier alone"; null or '' = "clear the override and
  // go back to the environment variable". Those are genuinely different
  // intents, and conflating them makes clearing an override impossible.
  if (raw === undefined) return { skip: true };
  if (raw === null || String(raw).trim() === '') return { value: null };
  const v = String(raw).trim();
  if (v.length > 200 || !MODEL_ID_RE.test(v)) {
    return { error: `${key} must look like "vendor/model" or "vendor/model:tag"` };
  }
  return { value: v };
}

router.get('/ai/routing', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT primary_model, secondary_model, fallback_model,
              updated_by_name, updated_at
         FROM platform_ai_settings WHERE id = 'singleton'`
    );
    const row = rows[0] || {};
    res.json({
      data: {
        override: {
          primary: row.primary_model ?? null,
          secondary: row.secondary_model ?? null,
          fallback: row.fallback_model ?? null,
        },
        // What a request would route to right now. Returned alongside the
        // override so an operator can see which tiers are following their
        // setting and which are still on the environment, rather than
        // inferring it from a blank field.
        effective: {
          primary: aiModels.primary,
          secondary: aiModels.secondary,
          fallback: aiModels.fallback,
        },
        from_env: {
          primary: process.env.AI_PRIMARY_MODEL || null,
          secondary: process.env.AI_SECONDARY_MODEL || null,
          fallback: process.env.AI_FALLBACK_MODEL || null,
        },
        defaults: AI_DEFAULTS,
        updated_by_name: row.updated_by_name ?? null,
        updated_at: row.updated_at ?? null,
      },
    });
  } catch (err) { next(err); }
});

router.put('/ai/routing', async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = {};
    for (const tier of ['primary', 'secondary', 'fallback']) {
      const r = readModelField(body, `${tier}_model`);
      if (r.error) return res.status(400).json({ error: { code: 'VALIDATION', message: r.error } });
      if (!r.skip) fields[`${tier}_model`] = r.value;
    }
    if (!Object.keys(fields).length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'No fields to update' } });
    }

    // The previous values go in the audit row. "Changed the primary model"
    // without the old value cannot be undone by whoever reads the log at 3am,
    // which is exactly when this entry gets read.
    const { rows: before } = await pool.query(
      `SELECT primary_model, secondary_model, fallback_model
         FROM platform_ai_settings WHERE id = 'singleton'`
    );

    const cols = Object.keys(fields);
    const { rows } = await pool.query(
      `UPDATE platform_ai_settings
          SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')},
              updated_by = $${cols.length + 1},
              updated_by_name = $${cols.length + 2},
              updated_at = now()
        WHERE id = 'singleton'
      RETURNING primary_model, secondary_model, fallback_model, updated_at`,
      [...cols.map((c) => fields[c]), req.user?.id || null, req.user?.name || null]
    );

    // Refresh this instance immediately so the operator sees their own change
    // take effect rather than waiting out the poll interval. Other instances
    // pick it up on their next refresh.
    await aiSettings.refresh();

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'ai_routing_updated','ai_platform','singleton',$3,$4,$5,$6)`,
      [req.user?.id || null, req.user?.name || null,
       before[0] || {}, rows[0] || {}, req.ip || null, req.get('user-agent') || null]
    );

    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});
// ── PUT|DELETE /organizations/:id/ai-limit ───────────────────────────────────
router.put('/organizations/:id/ai-limit', async (req, res, next) => {
  try {
    const { rows: org } = await pool.query('SELECT id, name FROM organizations WHERE id = $1', [req.params.id]);
    if (!org[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });

    const v = req.body?.monthly_tokens;
    let tokens;
    // null here is an explicit exemption, not "unset" — see lib/aiQuota.js.
    if (v === null || v === '') tokens = null;
    else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'monthly_tokens must be a non-negative number or null' } });
      }
      tokens = Math.trunc(n);
    }

    const { rows } = await pool.query(
      `INSERT INTO organization_ai_limits (organization_id, monthly_tokens, reason, set_by, set_by_name)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_id) DO UPDATE
         SET monthly_tokens = EXCLUDED.monthly_tokens, reason = EXCLUDED.reason,
             set_by = EXCLUDED.set_by, set_by_name = EXCLUDED.set_by_name, updated_at = now()
       RETURNING *`,
      [req.params.id, tokens, String(req.body?.reason || '').trim().slice(0, 500) || null,
       req.user?.id || null, req.user?.name || null]
    );

    await audit(req, 'ai_limit_set', 'organization', req.params.id,
      { monthly_tokens: tokens, studio: org[0].name, reason: rows[0].reason });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/organizations/:id/ai-limit', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM organization_ai_limits WHERE organization_id = $1 RETURNING *', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No limit set' } });
    await audit(req, 'ai_limit_cleared', 'organization', req.params.id,
      { previous_monthly_tokens: rows[0].monthly_tokens });
    res.json({ data: { cleared: true } });
  } catch (err) { next(err); }
});

module.exports = router;
