// src/modules/command-center/collectors/ai.collector.js
//
// AI operations: routing, volume, latency, fallback rate, tokens, cost.
//
// One honesty note that shapes this whole file. The brief asks for "Success
// Rate / Failure Rate", and `ai_usage_log` has no success column — its inserts
// carry model, provider, intent, tokens, latency and `used_fallback`
// (src/lib/ai/usage.js). Only calls that RETURNED are logged at all, so a
// literal success rate would be 100% by construction and would stay 100%
// through a total outage. What the table can honestly report is the FALLBACK
// rate: the share of requests where the primary model did not answer and a
// lower tier had to. That is the real degradation signal, so it is what this
// card grades on, named for what it is.
//
// Cost uses the same COST_SQL join as super-admin/ai.js rather than a second
// formula. Two places computing money differently is how a dashboard and an
// invoice end up disagreeing.
'use strict';

const { STATUS, result, unavailable } = require('../registry');
const pool = require('../../../db/pool');

const NAME = 'ai';

const LATENCY_WARN_MS = Number(process.env.CC_AI_LATENCY_WARN_MS) || 4000;
const LATENCY_CRIT_MS = Number(process.env.CC_AI_LATENCY_CRIT_MS) || 12000;
const FALLBACK_WARN = 0.10;
const FALLBACK_CRIT = 0.30;

// Identical to super-admin/ai.js. An unpriced model contributes tokens but
// zero cost rather than dropping the row to NULL.
const COST_SQL = `
  (COALESCE(r.prompt_per_1k_inr, 0)     * l.tokens_prompt     / 1000.0
 + COALESCE(r.completion_per_1k_inr, 0) * l.tokens_completion / 1000.0)`;

async function optional(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

async function collect() {
  const [today, routing, recent] = await Promise.all([
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT count(*)::int                                        AS requests,
               COALESCE(ROUND(AVG(NULLIF(l.latency_ms, 0)))::int, 0) AS avg_latency_ms,
               COALESCE(MAX(l.latency_ms), 0)::int                   AS max_latency_ms,
               COALESCE(SUM(l.tokens_total), 0)::bigint              AS tokens,
               count(*) FILTER (WHERE l.used_fallback)::int          AS fallbacks,
               count(DISTINCT l.model)::int                          AS models_used,
               COALESCE(SUM(${COST_SQL}), 0)::numeric                AS cost_inr
          FROM ai_usage_log l
          LEFT JOIN ai_model_rates r ON r.model = l.model
         WHERE l.created_at >= date_trunc('day', now())`);
      const r = rows[0];
      return {
        requests: r.requests,
        avg_latency_ms: r.avg_latency_ms,
        max_latency_ms: r.max_latency_ms,
        tokens: Number(r.tokens),
        fallbacks: r.fallbacks,
        models_used: r.models_used,
        cost_inr: Number(r.cost_inr),
      };
    }),
    optional(async () => {
      const { rows } = await pool.query(
        `SELECT primary_model, secondary_model, fallback_model, updated_at
           FROM platform_ai_settings WHERE id = 'singleton'`);
      const row = rows[0] || {};
      return {
        primary: row.primary_model ?? null,
        secondary: row.secondary_model ?? null,
        fallback: row.fallback_model ?? null,
        updated_at: row.updated_at ?? null,
      };
    }),
    // The last hour separately: a daily average hides an outage that started
    // twenty minutes ago, which is exactly the window an operator is looking at.
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT count(*)::int                                        AS requests,
               COALESCE(ROUND(AVG(NULLIF(latency_ms, 0)))::int, 0)   AS avg_latency_ms,
               count(*) FILTER (WHERE used_fallback)::int            AS fallbacks,
               (SELECT model FROM ai_usage_log
                 WHERE created_at >= now() - interval '1 hour'
                 ORDER BY created_at DESC LIMIT 1)                   AS last_model,
               (SELECT max(created_at) FROM ai_usage_log)            AS last_request_at
          FROM ai_usage_log
         WHERE created_at >= now() - interval '1 hour'`);
      return rows[0];
    }),
  ]);

  const hourRequests = recent?.requests ?? 0;
  const hourFallbackRate = hourRequests > 0 ? (recent.fallbacks ?? 0) / hourRequests : null;
  const hourLatency = recent?.avg_latency_ms ?? null;

  const data = {
    routing,
    // Which model actually served the most recent request — the brief's
    // "Current Active Model". Read from traffic, not from configuration,
    // because those two disagree precisely when something is wrong.
    active_model: recent?.last_model ?? null,
    last_request_at: recent?.last_request_at ?? null,
    today,
    last_hour: recent ? {
      requests: hourRequests,
      avg_latency_ms: hourLatency,
      fallbacks: recent.fallbacks ?? 0,
      fallback_rate: hourFallbackRate == null ? null : Math.round(hourFallbackRate * 1000) / 1000,
    } : null,
    // Stated so nobody reads the absence of a failure count as zero failures.
    note: 'ai_usage_log records returned calls only; fallback rate is the degradation signal, not a success rate',
  };

  let status = STATUS.HEALTHY;
  let reason = null;

  if (!routing || (!routing.primary && !routing.fallback)) {
    return unavailable(NAME, 'No AI routing configured in platform_ai_settings');
  }
  if (hourRequests === 0) {
    // Idle is not unhealthy. Overnight there is simply no traffic, and an
    // amber card every night is a card nobody looks at by the weekend.
    status = STATUS.HEALTHY;
    reason = null;
  } else if (hourFallbackRate != null && hourFallbackRate >= FALLBACK_CRIT) {
    status = STATUS.CRITICAL;
    reason = `${Math.round(hourFallbackRate * 100)}% of AI calls fell back off ${routing.primary} in the last hour`;
  } else if (hourLatency != null && hourLatency >= LATENCY_CRIT_MS) {
    status = STATUS.CRITICAL;
    reason = `AI average latency ${hourLatency}ms in the last hour`;
  } else if (hourFallbackRate != null && hourFallbackRate >= FALLBACK_WARN) {
    status = STATUS.WARNING;
    reason = `${Math.round(hourFallbackRate * 100)}% fallback rate in the last hour`;
  } else if (hourLatency != null && hourLatency >= LATENCY_WARN_MS) {
    status = STATUS.WARNING;
    reason = `AI average latency ${hourLatency}ms in the last hour`;
  }

  return result(NAME, { status, data, reason });
}

module.exports = { NAME, collect, COST_SQL, LATENCY_WARN_MS, LATENCY_CRIT_MS, FALLBACK_WARN, FALLBACK_CRIT };
