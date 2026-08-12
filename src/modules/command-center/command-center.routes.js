// src/modules/command-center/command-center.routes.js
//
// The console's HTTP surface: read-only snapshots (Phase 1–2) and the
// allow-listed operational commands (Phase 5).
//
// Mounted under /api/super-admin, so it inherits that mount's
// auth -> requireSuperAdmin -> requireSuperAdminMfa chain rather than declaring
// its own. This console has buttons that pause queues and delete failed jobs; it
// must never be reachable by a tenant admin, and the safest way to guarantee
// that is to not have a second door to guard.
'use strict';

const router = require('express').Router();
const { registerCollectors, registry, snapshot } = require('./index');
const commands = require('./commands.service');
const alerts = require('./alerts.service');
const guardian = require('./guardian.service');
const logBuffer = require('./logBuffer');
const logCapture = require('./logCapture');
const tickets = require('./tickets');
const stream = require('./stream');
const pool = require('../../db/pool');

registerCollectors();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * GET /api/super-admin/command-center/snapshot
 *   ?cards=runtime,redis   subset
 *   ?fresh=1               bypass the per-collector TTL cache
 *
 * Always 200 when the process is alive. A card that failed reports its own
 * status inside the payload — an ops console that 500s during an incident is
 * an ops console that is useless during an incident.
 */
router.get('/command-center/snapshot', wrap(async (req, res) => {
  const only = String(req.query.cards || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const data = await snapshot.collect({ only, fresh: req.query.fresh === '1' });
  res.json({ data });
}));

/**
 * POST /api/super-admin/command-center/stream-ticket
 *
 * Mints the single-use ticket that authenticates the realtime socket (Phase 3).
 * See tickets.js for why the socket cannot simply present the session cookie.
 *
 * A POST rather than a GET because minting a credential is a state change and
 * should look like one: a GET's full URL is the kind of thing that gets
 * prefetched, cached and pasted into a chat window.
 *
 * It returns the PATH, not a full URL. The origin is the client's to decide
 * (the frontend derives it from NEXT_PUBLIC_API_URL in `wsBase()`), and a
 * server that guesses its own public URL guesses wrong the first time it sits
 * behind a proxy — which it does here.
 */
router.post('/command-center/stream-ticket', wrap(async (req, res) => {
  const { ticket, expires_in_ms } = tickets.issue(req.user);
  res.json({ data: { ticket, expires_in_ms, path: stream.PATH, tick_ms: stream.TICK_MS } });
}));

/** The card names this build knows about, for the client to render a grid. */
router.get('/command-center/cards', wrap(async (_req, res) => {
  res.json({ data: { cards: registry.names(), statuses: Object.values(registry.STATUS) } });
}));

/**
 * GET /api/super-admin/command-center/commands
 *
 * The whole allow-list, including entries that cannot run here — each carries
 * its own `unavailable_reason`. The console renders the full recovery ladder
 * with the missing rungs disabled and explained, rather than hiding them and
 * looking more complete than it is.
 */
router.get('/command-center/commands', wrap(async (_req, res) => {
  res.json({ data: { commands: commands.list() } });
}));

/**
 * POST /api/super-admin/command-center/commands/:name
 * body: { queue?, confirm?, dryRun? }
 *
 * `:name` is looked up in the allow-list — it is never interpolated into
 * anything — and an unknown name 404s before any work happens.
 *
 * The failure codes are distinct on purpose, because the client's response to
 * each differs: 428 means show the confirmation prompt, 429 means the button
 * is on cooldown, 503 means the capability is absent on this deployment.
 */
router.post('/command-center/commands/:name', wrap(async (req, res, next) => {
  const { queue, confirm, dryRun } = req.body || {};
  try {
    const data = await commands.run(req.params.name, {
      req,
      queue: typeof queue === 'string' ? queue : undefined,
      confirm: typeof confirm === 'string' ? confirm : undefined,
      dryRun: dryRun === true,
    });
    res.json({ data });
  } catch (err) {
    if (!err.status) return next(err);
    res.status(err.status).json({
      error: { code: err.code || 'COMMAND_FAILED', message: err.message },
    });
  }
}));

// ── Alert Center ────────────────────────────────────────────────────────────
//
// There is no "evaluate now" route. Forcing an evaluation is an operator action
// with a cost, and the Command Center already has the machinery for those —
// allow-listed, audited, cooldown-guarded. It is `alerts.evaluate` in
// commands.service.js rather than a fourth door here.

/**
 * GET /api/super-admin/command-center/alerts
 *   ?scope=live|resolved|all   default live
 *   ?limit=                    capped server-side
 *
 * Returns the alerts plus the counts the badge needs, in one call — the console
 * would otherwise ask for both on every poll.
 */
router.get('/command-center/alerts', wrap(async (req, res) => {
  const scope = ['live', 'resolved', 'all'].includes(String(req.query.scope))
    ? String(req.query.scope) : 'live';
  res.json({ data: await alerts.list({ scope, limit: req.query.limit }) });
}));

/** Acknowledge: "seen, I am on it". Does not stop the alert tracking. */
router.post('/command-center/alerts/:id/ack', wrap(async (req, res, next) => {
  try {
    res.json({ data: await alerts.acknowledge(req.params.id, req) });
  } catch (err) {
    if (!err.status) return next(err);
    res.status(err.status).json({ error: { code: 'ALERT_NOT_OPEN', message: err.message } });
  }
}));

/** Close by hand. Recorded as `manual`, which is how bad detection stays visible. */
router.post('/command-center/alerts/:id/resolve', wrap(async (req, res, next) => {
  try {
    res.json({ data: await alerts.resolve(req.params.id, req) });
  } catch (err) {
    if (!err.status) return next(err);
    res.status(err.status).json({ error: { code: 'ALERT_NOT_LIVE', message: err.message } });
  }
}));

// ── AI Guardian ─────────────────────────────────────────────────────────────

/**
 * GET /api/super-admin/command-center/guardian
 *
 * Deterministic correlations across cards. No AI is called here — this is the
 * rules engine, and it answers in single-digit milliseconds off the cached
 * snapshot. An empty `findings` with a `note` means the rules RAN and matched
 * nothing, which is a different claim from the Guardian not having run.
 */
router.get('/command-center/guardian', wrap(async (req, res) => {
  res.json({ data: await guardian.analyse({ fresh: req.query.fresh === '1' }) });
}));

/**
 * POST /api/super-admin/command-center/guardian/:id/explain
 *
 * Narrates ONE finding. Separate from the read above, and a POST, because it
 * costs money: narrating on every poll would spend tokens restating text
 * already on screen. The model is given the finding and its evidence, never the
 * raw snapshot, and it cannot change the diagnosis, severity or confidence.
 */
router.post('/command-center/guardian/:id/explain', wrap(async (req, res, next) => {
  try {
    res.json({ data: await guardian.explain(req.params.id) });
  } catch (err) {
    if (!err.status) return next(err);
    res.status(err.status).json({ error: { code: 'FINDING_NOT_ACTIVE', message: err.message } });
  }
}));

// ── Live Logs (D4) ──────────────────────────────────────────────────────────
//
// Two reads, because the two halves of the hybrid answer different questions
// and merging them would misrepresent both.
//
//   /logs          the in-memory ring: everything recent, THIS process only,
//                  empty after a deploy. This is the live tail.
//   /logs/history  `system_logs`: errors and above, durable, and covering the
//                  worker container as well as this one.

const LEVELS = logBuffer.LEVELS;

/** Map a level name to its numeric floor. Unknown names mean "no floor". */
function minLevelOf(name) {
  const n = LEVELS[String(name || '').toLowerCase()];
  return typeof n === 'number' ? n : 0;
}

/**
 * GET /api/super-admin/command-center/logs
 *   ?level=warn   floor, inclusive
 *   ?q=           substring of the message
 *   ?since=       epoch ms — only lines strictly newer, for cheap polling
 *   ?limit=
 */
router.get('/command-center/logs', wrap(async (req, res) => {
  const lines = logBuffer.tail({
    minLevel: minLevelOf(req.query.level),
    q: req.query.q,
    since: Number(req.query.since) || 0,
    limit: Number(req.query.limit) || 200,
  });

  res.json({
    data: {
      lines,
      stats: logBuffer.stats(),
      capture: logCapture.stats(),
      // Said explicitly, because an operator who does not know this will look
      // at a tail with no worker lines and conclude the worker is not logging.
      scope_note: `In-memory ring for the '${logCapture.SOURCE}' process only, `
        + 'cleared on restart. Worker errors are under History.',
    },
  });
}));

/**
 * GET /api/super-admin/command-center/logs/history
 *   ?level=error  floor (defaults to error — nothing below it is persisted)
 *   ?source=api|worker
 *   ?q=
 *   ?limit=
 */
router.get('/command-center/logs/history', wrap(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const minLevel = minLevelOf(req.query.level) || logCapture.PERSIST_FROM_LEVEL;

  const where = ['level >= $1'];
  const params = [minLevel];

  if (req.query.source === 'api' || req.query.source === 'worker') {
    params.push(req.query.source);
    where.push(`source = $${params.length}`);
  }
  if (req.query.q) {
    // Parameterised, never interpolated. These rows are read by a super admin
    // but the value still arrives from a query string.
    params.push(`%${String(req.query.q)}%`);
    where.push(`msg ILIKE $${params.length}`);
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, level, level_label, logged_at, msg, source, pid, hostname, context
       FROM system_logs
      WHERE ${where.join(' AND ')}
      ORDER BY logged_at DESC
      LIMIT $${params.length}`,
    params,
  );

  const { rows: counts } = await pool.query(
    `SELECT
       COUNT(*)::int                                          AS total,
       COUNT(*) FILTER (WHERE source = 'worker')::int          AS from_worker,
       COUNT(*) FILTER (WHERE level >= 60)::int                AS fatal,
       COUNT(*) FILTER (WHERE logged_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
       MIN(logged_at)                                          AS oldest
     FROM system_logs`,
  );

  res.json({ data: { lines: rows, stats: counts[0] } });
}));

module.exports = router;
