'use strict';
const pool   = require('../../db/pool');
const logger = require('../logger');

/**
 * Log a completed AI request to the usage_log table.
 * Never throws — logging failures must not break the response.
 */
async function logUsage({
  user_id, conversation_id, model, provider = 'openrouter',
  intent_type = 'fitness', tokens_prompt = 0, tokens_completion = 0,
  latency_ms = 0, used_fallback = false,
}) {
  try {
    await pool.query(
      `INSERT INTO ai_usage_log
         (user_id, conversation_id, model, provider, intent_type,
          tokens_prompt, tokens_completion, tokens_total,
          latency_ms, used_fallback)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        user_id,
        conversation_id || null,
        model,
        provider,
        intent_type,
        tokens_prompt,
        tokens_completion,
        tokens_prompt + tokens_completion,
        latency_ms,
        used_fallback,
      ]
    );
  } catch (err) {
    logger.error({ err: err.message }, 'ai_usage_log_insert_failed');
  }
}

/**
 * Get usage totals for a single user.
 */
async function getUserUsage(user_id) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)         FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour')  AS requests_this_hour,
       COUNT(*)         FILTER (WHERE created_at >= CURRENT_DATE)               AS requests_today,
       COALESCE(SUM(tokens_total)   FILTER (WHERE created_at >= CURRENT_DATE), 0) AS tokens_today,
       COUNT(*)         FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS requests_30d,
       COALESCE(SUM(tokens_total)   FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0) AS tokens_30d,
       COUNT(*)         FILTER (WHERE used_fallback AND created_at >= NOW() - INTERVAL '30 days') AS fallback_count_30d
     FROM ai_usage_log
     WHERE user_id = $1`,
    [user_id]
  );
  return rows[0];
}

/**
 * Per-model breakdown for the last 30 days (admin view).
 */
async function getModelStats() {
  const { rows } = await pool.query(
    `SELECT
       model,
       provider,
       intent_type,
       COUNT(*)                                                   AS requests,
       COALESCE(SUM(tokens_total),0)                             AS tokens_total,
       COALESCE(SUM(tokens_prompt),0)                            AS tokens_prompt,
       COALESCE(SUM(tokens_completion),0)                        AS tokens_completion,
       COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)        AS requests_today,
       AVG(latency_ms)::INTEGER                                  AS avg_latency_ms,
       COUNT(*) FILTER (WHERE used_fallback)                     AS fallback_count
     FROM ai_usage_log
     WHERE created_at >= NOW() - INTERVAL '30 days'
     GROUP BY model, provider, intent_type
     ORDER BY requests DESC`
  );
  return rows;
}

module.exports = { logUsage, getUserUsage, getModelStats };
