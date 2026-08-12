'use strict';
// Operator overrides for AI model routing.
//
// models.js exposes three SYNCHRONOUS getters that every AI call path reads.
// Making them async to consult the database would ripple through the router,
// the streaming path and every generator — a large change to a hot path for a
// value that changes a handful of times a year.
//
// So this keeps a small in-process cache instead. The getters stay synchronous
// and read the cache; a background refresh keeps it current.
//
// This file is ONLY about which model each tier routes to. Token allowances
// and cost rates belong to the AI Control Centre (migration 126) and are
// deliberately not duplicated here — two places to look up a studio's AI
// limits is one place too many.
//
// ── The cache starts EMPTY, and empty means "use the environment" ─────────
//
// That is the whole safety argument. Before the first refresh lands, during a
// database outage, and on any query error, the cache holds nothing and every
// tier resolves to its environment variable — exactly the behaviour that
// existed before this file. There is no state in which a failure here changes
// which model a request routes to; the worst case is that an operator's new
// setting takes up to REFRESH_MS to be picked up by a given instance.

const pool = require('../../db/pool');
const logger = require('../logger');

// Long on purpose. Model routing changes are rare and deliberate; polling the
// database every few seconds for a value that changes twice a year is waste.
// A write refreshes the writing instance immediately (see refresh()), so the
// operator sees their own change take effect at once.
const REFRESH_MS = parseInt(process.env.AI_SETTINGS_REFRESH_MS, 10) || 60_000;

/** @type {{primary_model: string|null, secondary_model: string|null, fallback_model: string|null}|null} */
let cache = null;
let timer = null;

async function refresh() {
  try {
    const { rows } = await pool.query(
      `SELECT primary_model, secondary_model, fallback_model
         FROM platform_ai_settings WHERE id = 'singleton'`
    );
    cache = rows[0] || null;
  } catch (err) {
    // Deliberately does NOT clear the cache. A transient error should not
    // yank an operator's chosen model out from under in-flight traffic and
    // silently swap the platform back to the environment default.
    logger.warn({ err: err.message }, 'ai settings refresh failed — keeping last known values');
  }
  return cache;
}

/** Model override for a tier, or null to use the environment variable. */
function override(tier) {
  if (!cache) return null;
  const v = cache[`${tier}_model`];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Start the background refresh. Called once at boot. Safe to call twice.
 * The timer is unref'd so it never holds the process open — a pending refresh
 * must not keep a container alive or stall a test run.
 */
function start() {
  if (timer) return;
  refresh().catch(() => {});
  timer = setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seams. Not used in production code. */
function _setCache(v) { cache = v; }
function _timer() { return timer; }

module.exports = { refresh, override, start, stop, _setCache, _timer };
