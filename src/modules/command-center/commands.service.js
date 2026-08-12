// src/modules/command-center/commands.service.js
//
// The allow-listed operational actions the console can run.
//
// ── Why an allow-list and not a generic executor ────────────────────────────
//
// This is a super-admin console with buttons that touch production. The safe
// shape is a fixed set of named operations, each with a declared blast radius,
// rather than anything that takes a command, a queue name, or a shell string
// from the client and acts on it. Nothing here interpolates client input into a
// command; the only thing a caller chooses is WHICH named entry runs and, where
// the entry allows it, which queue from QUEUE_NAMES.
//
// ── The rule that shaped `cache.flush` ──────────────────────────────────────
//
// The brief asks for a Flush Cache button. On this system that button, built
// the obvious way, would be a data-loss bug: Redis here holds NOTHING but
// BullMQ. Grep confirms it — no set/get/hset outside the queue modules. So
// FLUSHDB would not clear a cache, it would delete every queued job, on a Redis
// deliberately configured `appendonly yes` + `noeviction` because, as the
// compose file puts it, "a queue that empties on reboot is not a queue".
//
// So cache.flush clears the Command Center's own collector TTL cache — a real
// cache, safe to drop, and the thing an operator actually wants when they ask
// for fresh numbers. It does not touch Redis, and says so.
'use strict';

const logger = require('../../lib/logger');
const { logActivity } = require('../../lib/activityLog');
const snapshot = require('./snapshot.service');
const registry = require('./registry');
const redis = require('../../lib/redis');
const pool = require('../../db/pool');
const email = require('../../lib/email');
const { QUEUE_NAMES } = require('../../jobs/queue');

/** Rungs 4 and 5 of the recovery ladder need the Docker socket — see D6. */
const DOCKER_REASON =
  'Requires the Docker socket. The API container has no /var/run/docker.sock; '
  + 'see COMMAND-CENTER-PLAN.md §2 for the socket-proxy compose change.';

/** Last run per command, for the cooldown. */
const lastRun = new Map();

function assertQueue(name) {
  // The only client-chosen value any handler accepts, and it must be one of the
  // five known names — never a string passed through to Redis.
  if (!QUEUE_NAMES.includes(name)) {
    const err = new Error(`Unknown queue: ${name}`);
    err.status = 400;
    throw err;
  }
  return name;
}

/**
 * Wait for a queue to finish what it is already running.
 *
 * Bounded at 30s to match the worker container's stop_grace_period: past that
 * point a deploy would SIGKILL the job anyway, and for membership-renewals a
 * job killed mid-flight is a card charged with no membership row written.
 */
async function drainQueue(queue, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const active = await queue.getActiveCount();
    if (active === 0) return { drained: true, waited_ms: Date.now() - started, active: 0 };
    if (Date.now() - started >= timeoutMs) {
      return { drained: false, waited_ms: Date.now() - started, active };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ── The allow-list ──────────────────────────────────────────────────────────
//
// destructive: true      -> requires a typed confirmation from the operator
// unavailable: string    -> cannot run here; the reason is shown instead
// cooldownMs             -> the same command cannot be re-run inside this window

const COMMANDS = {
  'health.check': {
    label: 'Run health check',
    description: 'Re-probes every collector, bypassing the TTL cache.',
    blastRadius: 'Read-only.',
    cooldownMs: 2_000,
    async run() {
      return snapshot.collect({ fresh: true });
    },
  },

  'cache.flush': {
    label: 'Flush collector cache',
    description:
      'Drops the Command Center\'s cached collector results so the next read re-probes. '
      + 'Does NOT touch Redis: on this deployment Redis holds only BullMQ, so flushing it '
      + 'would delete queued jobs, not a cache.',
    blastRadius: 'In-memory cache of this process only.',
    cooldownMs: 1_000,
    async run() {
      snapshot.invalidate();
      return { flushed: 'collector-snapshot-cache', redis_touched: false };
    },
  },

  'alerts.evaluate': {
    label: 'Evaluate alerts now',
    description:
      'Runs an alerting pass immediately instead of waiting for the 60s tick. '
      + 'Opens, escalates and auto-resolves exactly as the tick would.',
    blastRadius:
      'Can open or close alerts, and announce a new one to every platform operator. '
      + 'It cannot change anything the tick would not have changed a minute later.',
    cooldownMs: 10_000,
    async run() {
      // Required lazily to keep the alerting module out of the boot path of a
      // process that only ever reads snapshots.
      const alerts = require('./alerts.service');
      const out = await alerts.evaluate({ fresh: true });
      return {
        evaluated: out.evaluated,
        opened: out.opened.map((a) => a.source),
        escalated: out.escalated.map((a) => a.source),
        resolved: out.resolved.map((a) => a.source),
        ongoing: out.ongoing,
      };
    },
  },

  'database.test': {
    label: 'Test database',
    description: 'Round-trips a trivial query and reports latency and pool state.',
    blastRadius: 'Read-only.',
    cooldownMs: 2_000,
    async run() {
      const t0 = Date.now();
      const { rows } = await pool.query('SELECT current_database() AS db, version() AS version');
      return {
        ok: true,
        latency_ms: Date.now() - t0,
        database: rows[0].db,
        version: String(rows[0].version).split(' ').slice(0, 2).join(' '),
        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      };
    },
  },

  'redis.test': {
    label: 'Test Redis',
    description: 'PINGs Redis through the shared client and reports latency.',
    blastRadius: 'Read-only.',
    cooldownMs: 2_000,
    get unavailable() {
      return redis.isConfigured() ? null : 'REDIS_URL is not set — queues run inline.';
    },
    async run() {
      const t0 = Date.now();
      await redis.ping();
      return { ok: true, latency_ms: Date.now() - t0 };
    },
  },

  'smtp.test': {
    label: 'Test SMTP',
    description:
      'Opens a real SMTP connection and runs the handshake. This is the one probe '
      + 'the tick deliberately never makes.',
    blastRadius: 'One outbound connection to the mail provider. Sends no mail.',
    cooldownMs: 10_000,
    async run() {
      const out = await email.verifyConnection();
      // verifyConnection resolves either way; a failed handshake is a result,
      // not an exception, and carries lib/email.js's typed diagnosis.
      return out;
    },
  },

  'ai.test': {
    label: 'Test AI',
    description: 'Sends a minimal prompt through the configured routing and reports the model that answered.',
    blastRadius: 'One AI request. Consumes a small number of tokens and costs money.',
    cooldownMs: 15_000,
    async run() {
      // Required lazily: the AI stack pulls a large dependency tree, and a
      // console that never presses this button should not pay for it at boot.
      const { routedChat } = require('../../lib/ai/router');
      const t0 = Date.now();
      const res = await routedChat({
        intent: 'chat',
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        max_tokens: 10,
      });
      return {
        ok: true,
        latency_ms: Date.now() - t0,
        model: res?.model ?? null,
        used_fallback: res?.used_fallback ?? null,
        reply: typeof res?.content === 'string' ? res.content.slice(0, 100) : null,
      };
    },
  },

  // ── Recovery ladder, rungs 1–3 ────────────────────────────────────────────
  // Reversible and in-process. Nothing here restarts anything.

  'queue.pause': {
    label: 'Pause queue',
    description: 'Stops new jobs being picked up. Jobs already running continue.',
    blastRadius: 'One queue stops draining until resumed. Nothing is lost — work accumulates.',
    cooldownMs: 1_000,
    acceptsQueue: true,
    get unavailable() {
      return redis.isConfigured() ? null : 'REDIS_URL is not set — there is no queue to pause.';
    },
    async run({ queue: name }) {
      const { getQueue } = require('../../jobs/queue');
      const q = getQueue(assertQueue(name));
      await q.pause();
      return { queue: name, paused: true, active: await q.getActiveCount() };
    },
  },

  'queue.drain': {
    label: 'Drain queue',
    description: 'Waits, up to 30s, for jobs already running to finish. Pause first.',
    blastRadius: 'Read-only — it only waits and reports.',
    cooldownMs: 1_000,
    acceptsQueue: true,
    get unavailable() {
      return redis.isConfigured() ? null : 'REDIS_URL is not set — there is no queue to drain.';
    },
    async run({ queue: name }) {
      const { getQueue } = require('../../jobs/queue');
      return drainQueue(getQueue(assertQueue(name)));
    },
  },

  'queue.resume': {
    label: 'Resume queue',
    description: 'Starts picking up jobs again.',
    blastRadius: 'One queue begins draining its backlog.',
    cooldownMs: 1_000,
    acceptsQueue: true,
    get unavailable() {
      return redis.isConfigured() ? null : 'REDIS_URL is not set — there is no queue to resume.';
    },
    async run({ queue: name }) {
      const { getQueue } = require('../../jobs/queue');
      const q = getQueue(assertQueue(name));
      await q.resume();
      return { queue: name, paused: false, waiting: await q.getWaitingCount() };
    },
  },

  'queue.retryFailed': {
    label: 'Retry failed jobs',
    description: 'Moves failed jobs back onto the queue.',
    blastRadius: 'Re-runs work that already failed once. Side effects repeat — an email may send twice.',
    destructive: true,
    cooldownMs: 10_000,
    acceptsQueue: true,
    get unavailable() {
      return redis.isConfigured() ? null : 'REDIS_URL is not set.';
    },
    async run({ queue: name }) {
      const { getQueue } = require('../../jobs/queue');
      const q = getQueue(assertQueue(name));
      const failed = await q.getFailed(0, 500);
      let retried = 0;
      for (const job of failed) {
        try { await job.retry(); retried += 1; } catch { /* already retried or gone */ }
      }
      return { queue: name, found: failed.length, retried };
    },
  },

  'queue.clearFailed': {
    label: 'Clear failed jobs',
    description: 'Permanently removes failed jobs from the queue.',
    blastRadius:
      'IRREVERSIBLE. The failed jobs and their payloads are gone — including the record of '
      + 'what was supposed to happen. Export or read them first.',
    destructive: true,
    cooldownMs: 30_000,
    acceptsQueue: true,
    get unavailable() {
      return redis.isConfigured() ? null : 'REDIS_URL is not set.';
    },
    async run({ queue: name }) {
      const { getQueue } = require('../../jobs/queue');
      const q = getQueue(assertQueue(name));
      const before = await q.getFailedCount();
      await q.clean(0, 10_000, 'failed');
      return { queue: name, removed_approx: before, remaining: await q.getFailedCount() };
    },
  },

  // ── One Click Recovery ────────────────────────────────────────────────────
  //
  // The D5 ladder as one action: pause -> wait for in-flight work -> resume,
  // re-checking health at each step and STOPPING as soon as the queue recovers.
  //
  // Stopping early is the point. A recovery routine that always runs to the end
  // is a routine that restarts a healthy worker, and the reason ops teams stop
  // trusting the button. Each rung is only climbed because the one below it did
  // not work.
  //
  // Rungs 4-5 (restart worker, restart container) are part of the ladder and
  // are NOT reached here, because they need the Docker socket. The result says
  // so rather than quietly finishing at rung 3 and reporting success.
  'recovery.run': {
    label: 'One Click Recovery',
    description:
      'Runs the recovery ladder on one queue: pause, let in-flight jobs finish, resume — '
      + 'stopping as soon as the queue is healthy again.',
    blastRadius:
      'The queue stops accepting new work for up to 30 seconds while jobs already running '
      + 'finish. Nothing is lost — work accumulates and drains on resume. If the queue does '
      + 'not recover, the next rung needs the Docker socket and will be reported, not run.',
    destructive: true,
    cooldownMs: 30_000,
    acceptsQueue: true,
    get unavailable() {
      return redis.isConfigured() ? null : 'REDIS_URL is not set — there is no queue to recover.';
    },
    async run({ queue: name }) {
      const { getQueue } = require('../../jobs/queue');
      const q = getQueue(assertQueue(name));
      const steps = [];

      const health = async () => {
        // Reuse the collector rather than a second definition of "healthy" —
        // a recovery routine that disagreed with the console about whether it
        // worked would be worse than no routine.
        const { collect } = require('./collectors/queue.collector');
        const card = await collect();
        const mine = (card.data?.queues ?? []).find((x) => x.name === name) ?? null;
        return { status: card.status, queue: mine };
      };

      const before = await health();
      steps.push({ step: 'assess', ...before });

      steps.push({ step: 'pause', done: true });
      await q.pause();

      const drained = await drainQueue(q);
      steps.push({ step: 'drain', ...drained });

      await q.resume();
      steps.push({ step: 'resume', done: true });

      const after = await health();
      steps.push({ step: 'verify', ...after });

      const recovered = after.status === 'healthy'
        || (after.queue && after.queue.waiting === 0);

      return {
        queue: name,
        recovered: Boolean(recovered),
        steps,
        // Honest about where the ladder stops on this deployment.
        next_rung: recovered ? null : {
          command: 'worker.restart',
          available: false,
          reason: DOCKER_REASON,
        },
      };
    },
  },

  // ── Recovery ladder, rungs 4–5 — declared, not yet runnable ───────────────
  // Present so the console shows the whole ladder and says exactly what is
  // missing, rather than hiding the rungs and looking complete.

  'worker.restart': {
    label: 'Restart worker container',
    description: 'Rung 4: restarts the worker container after pause/drain/resume did not recover it.',
    blastRadius: 'The worker stops for a few seconds. In-flight jobs get SIGTERM with a 30s grace.',
    destructive: true,
    get unavailable() { return DOCKER_REASON; },
    async run() { throw new Error(DOCKER_REASON); },
  },

  'container.restart': {
    label: 'Restart API container',
    description: 'Rung 5: last resort before paging a human.',
    blastRadius: 'The API is unreachable for a few seconds. Every in-flight request fails.',
    destructive: true,
    get unavailable() { return DOCKER_REASON; },
    async run() { throw new Error(DOCKER_REASON); },
  },
};

/** Describe every command for the console, including the ones that cannot run. */
function list() {
  return Object.entries(COMMANDS).map(([name, c]) => ({
    name,
    label: c.label,
    description: c.description,
    blast_radius: c.blastRadius,
    destructive: Boolean(c.destructive),
    accepts_queue: Boolean(c.acceptsQueue),
    queues: c.acceptsQueue ? QUEUE_NAMES : null,
    unavailable_reason: c.unavailable ?? null,
    cooldown_ms: c.cooldownMs ?? 0,
  }));
}

/**
 * Run one named command.
 *
 * @param {string} name
 * @param {object} opts
 * @param {object} opts.req           for audit attribution
 * @param {string} [opts.queue]       for acceptsQueue commands
 * @param {string} [opts.confirm]     must equal the command name for destructive ones
 * @param {boolean} [opts.dryRun]     describe without executing
 */
async function run(name, { req, queue, confirm, dryRun = false } = {}) {
  const cmd = COMMANDS[name];
  if (!cmd) {
    const err = new Error(`Unknown command: ${name}`);
    err.status = 404;
    throw err;
  }

  // Availability is checked FIRST, ahead of the confirmation gate: otherwise an
  // operator types the name of a command that was never going to run and only
  // learns it is impossible on the second press.
  const unavailable = cmd.unavailable;
  if (unavailable) {
    const err = new Error(unavailable);
    err.status = 503;
    err.code = 'COMMAND_UNAVAILABLE';
    throw err;
  }

  // Validate the one client-chosen value here rather than inside the handler,
  // so a bad name is a 400 that never reaches Redis and never burns the
  // cooldown — a rejected request must not lock the operator out of the real one.
  if (cmd.acceptsQueue) assertQueue(queue);

  // Typed confirmation. Deliberately the command's own name rather than a
  // generic "yes": it cannot be satisfied by a click-through, and it means the
  // operator has read which command they are firing.
  if (cmd.destructive && confirm !== name) {
    const err = new Error(`This command is destructive. Re-send with confirm="${name}". Blast radius: ${cmd.blastRadius}`);
    err.status = 428;
    err.code = 'CONFIRMATION_REQUIRED';
    throw err;
  }

  if (dryRun) {
    return {
      dry_run: true, command: name, queue: queue ?? null,
      would_run: cmd.label, blast_radius: cmd.blastRadius,
    };
  }

  // Cooldown. Stops a double-click firing a restart twice and a stuck operator
  // hammering a probe that is already timing out.
  const since = Date.now() - (lastRun.get(name) ?? 0);
  if (cmd.cooldownMs && since < cmd.cooldownMs) {
    const err = new Error(`Ran ${Math.round(since / 1000)}s ago; wait ${Math.ceil((cmd.cooldownMs - since) / 1000)}s`);
    err.status = 429;
    err.code = 'COOLDOWN';
    throw err;
  }
  lastRun.set(name, Date.now());

  const started = Date.now();
  let outcome = 'ok';
  let output = null;
  let error = null;
  try {
    output = await cmd.run({ queue, req });
  } catch (err) {
    outcome = 'error';
    error = err.message;
    logger.error({ err: err.message, command: name }, 'command-center command failed');
  }

  const duration = Date.now() - started;

  // Audited whether it worked or not: a failed restart is more interesting
  // than a successful one, and "who pressed this" is the question asked after.
  await logActivity(req, `command_center.${name}`, 'command_center', name, {
    queue: queue ?? null,
    outcome,
    duration_ms: duration,
    destructive: Boolean(cmd.destructive),
    error,
  }).catch(() => { /* auditing must not mask the result */ });

  if (outcome === 'error') {
    const err = new Error(error);
    err.status = 500;
    throw err;
  }

  return { command: name, queue: queue ?? null, outcome, duration_ms: duration, output };
}

/** Tests only. */
function _resetCooldowns() { lastRun.clear(); }

module.exports = { COMMANDS, list, run, drainQueue, _resetCooldowns, DOCKER_REASON, registry };
