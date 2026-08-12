// src/modules/command-center/guardian.rules.js
//
// The correlations. Each rule turns several cards into ONE diagnosis.
//
// ── The boundary between this and Phase 2 ───────────────────────────────────
//
// Collectors own thresholds. "Redis memory is 91%" is a collector's job and it
// already does it. A rule that re-checked a threshold would be a second place
// for the number to live and a second place for it to go stale.
//
// What a collector cannot do is look at ANOTHER card. Every rule here is a
// statement that only makes sense across two or more:
//
//   "jobs are waiting" is a queue fact.
//   "jobs are waiting AND Redis is fine" is a diagnosis: the worker is the
//   problem, and restarting Redis would be the wrong move.
//
// That is the whole value of this layer, and it is also its limit — a rule
// that reads one card is a threshold wearing a hat, and does not belong here.
//
// ── Signals: triggers and corroboration ─────────────────────────────────────
//
// `triggers`      ALL must fire, or there is no finding. These define the
//                 shape of the problem.
// `corroborating` raise confidence when they fire. They do not create a
//                 finding on their own.
//
// A signal whose card is UNAVAILABLE returns `null`, not false, and that
// distinction is load-bearing: "Redis is healthy" and "we cannot see Redis"
// are different states, and a rules engine that conflates them will confidently
// blame the worker on a box where Redis was never configured.
'use strict';

/** Read a dotted path, returning undefined rather than throwing. */
function pick(src, path) {
  let cur = src;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * A card's value, or `null` when the card cannot answer.
 *
 * `null` propagates all the way to the confidence calculation as "unknown",
 * which is the only honest thing to do with a probe that did not run.
 */
function val(cards, cardName, path) {
  const card = cards[cardName];
  if (!card) return null;
  if (card.status === 'unavailable' || card.status === 'timeout') return null;
  const v = pick(card.data, path);
  return v === undefined ? null : v;
}

/** Is a card reporting the given status? Null when it could not be probed. */
function statusIs(cards, cardName, ...wanted) {
  const card = cards[cardName];
  if (!card) return null;
  if (card.status === 'unavailable') return null;
  return wanted.includes(card.status);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Every rule. Order is presentation order for equal severity.
 *
 * `recommend` names Phase 5 commands. Advisory only — the Guardian never runs
 * anything; it puts the button next to the diagnosis and the operator presses
 * it. A rule with no command that helps says so, which is more useful than a
 * recommendation that does nothing.
 */
const RULES = [
  {
    id: 'worker.starvation',
    title: 'Jobs are queued but nothing is running them',
    severity: 'critical',
    // The classic misdiagnosis this exists to prevent: the queue card is red,
    // so somebody restarts Redis. Redis is fine. The worker is not consuming.
    conclusion:
      'Work is accumulating and no job is being processed, while Redis itself is answering '
      + 'normally. That points at the worker, not at Redis or the database.',
    triggers: [
      {
        key: 'jobs_waiting',
        describe: (c) => `${val(c, 'queues', 'totals.waiting')} jobs waiting`,
        test: (c) => {
          const w = num(val(c, 'queues', 'totals.waiting'));
          return w === null ? null : w > 0;
        },
      },
      {
        key: 'nothing_active',
        describe: () => 'no job is currently active',
        test: (c) => {
          const a = num(val(c, 'queues', 'totals.active'));
          return a === null ? null : a === 0;
        },
      },
    ],
    corroborating: [
      {
        key: 'redis_answering',
        weight: 3,
        describe: () => 'Redis is healthy, so the queue backend is not the cause',
        test: (c) => statusIs(c, 'redis', 'healthy', 'warning'),
      },
      {
        key: 'starved_flag',
        weight: 2,
        describe: () => 'the queue collector independently flagged starvation',
        test: (c) => {
          const qs = val(c, 'queues', 'queues');
          return Array.isArray(qs) ? qs.some((q) => q.starved) : null;
        },
      },
    ],
    recommend: ['queue.pause', 'queue.drain', 'queue.resume'],
    recovery: true,
  },

  {
    id: 'redis.enqueue_failure_imminent',
    title: 'Redis is close to the limit where enqueues start failing',
    severity: 'critical',
    // Specific to this deployment and easy to get wrong: on most Redis setups
    // hitting maxmemory evicts keys and the app carries on. Here the policy is
    // noeviction, deliberately, because Redis holds the job queue — so the
    // failure mode is not "cache misses", it is "the write is rejected".
    conclusion:
      'Memory is near maxmemory and the eviction policy is noeviction, so Redis will '
      + 'REJECT new writes rather than evict anything. Queued work stops being accepted — '
      + 'emails and membership renewals simply fail to enqueue.',
    triggers: [
      {
        key: 'memory_high',
        describe: (c) => `Redis memory at ${Math.round((num(val(c, 'redis', 'memory.used_ratio')) ?? 0) * 100)}% of maxmemory`,
        test: (c) => {
          const r = num(val(c, 'redis', 'memory.used_ratio'));
          return r === null ? null : r >= 0.8;
        },
      },
      {
        key: 'noeviction',
        describe: () => 'maxmemory-policy is noeviction',
        test: (c) => {
          const p = val(c, 'redis', 'memory.policy');
          return p === null ? null : String(p).includes('noeviction');
        },
      },
    ],
    corroborating: [
      {
        key: 'queue_depth',
        weight: 2,
        describe: (c) => `${val(c, 'queues', 'totals.waiting')} jobs are already queued, and they are what is in memory`,
        test: (c) => {
          const w = num(val(c, 'queues', 'totals.waiting'));
          return w === null ? null : w > 0;
        },
      },
      {
        key: 'failed_backlog',
        weight: 2,
        describe: (c) => `${val(c, 'queues', 'totals.failed')} failed jobs are being retained`,
        test: (c) => {
          const f = num(val(c, 'queues', 'totals.failed'));
          return f === null ? null : f > 0;
        },
      },
    ],
    // Failed jobs hold memory and are the safest thing to drop first — but it
    // is irreversible, which is why Phase 5 gates it behind a typed
    // confirmation rather than the Guardian firing it.
    recommend: ['queue.clearFailed'],
  },

  {
    id: 'mail.silently_discarded',
    title: 'Every invitation and password reset is being thrown away',
    severity: 'critical',
    conclusion:
      'Mail is not being delivered, and the endpoints that send it report success either '
      + 'way — forgot-password answers "sent" whether or not anything left the building. '
      + 'Nothing else on this console would surface that, which is why it went unnoticed.',
    triggers: [
      {
        key: 'smtp_broken',
        describe: () => 'the mail card is critical',
        test: (c) => statusIs(c, 'smtp', 'critical'),
      },
    ],
    corroborating: [
      {
        key: 'attempts_never_sent',
        weight: 4,
        describe: (c) => `${val(c, 'smtp', 'delivery.attempted_never_sent')} invitations were attempted and never sent`,
        test: (c) => {
          const n = num(val(c, 'smtp', 'delivery.attempted_never_sent'));
          return n === null ? null : n > 0;
        },
      },
      {
        key: 'never_delivered',
        weight: 2,
        describe: () => 'nothing has ever been delivered from this deployment',
        test: (c) => {
          const sent = num(val(c, 'smtp', 'delivery.invitations_sent'));
          const total = num(val(c, 'smtp', 'delivery.invitations_total'));
          if (sent === null || total === null) return null;
          return total > 0 && sent === 0;
        },
      },
      {
        // The cross-card half, and the one that decides WHERE to look. Mail is
        // sent through the email queue, so a backlog of failed email jobs says
        // the sends are being attempted and rejected at the transport — an
        // SMTP/network problem. Mail failing with a clean email queue would
        // mean the sends are not being attempted at all, which is a different
        // bug in a different file.
        key: 'email_jobs_failing',
        weight: 3,
        describe: () => 'the email queue is accumulating failures, so sends are being attempted and rejected',
        test: (c) => {
          const qs = val(c, 'queues', 'queues');
          if (!Array.isArray(qs)) return null;
          const email = qs.find((q) => q.name === 'email');
          return email ? (email.failed ?? 0) > 0 : null;
        },
      },
    ],
    // Deliberately empty. No allow-listed command fixes a blocked SMTP port,
    // and offering one that cannot help is worse than offering none.
    recommend: [],
    advice:
      'No command here can fix this — it is configuration, not state. The likely cause on a '
      + 'VPS is a blocked outbound SMTP port. `resend` is already a dependency and delivers '
      + 'over HTTPS, so setting RESEND_API_KEY bypasses the port entirely; '
      + 'notifications.service.js already prefers it when present.',
  },

  {
    id: 'runtime.event_loop_blocked',
    title: 'The event loop is being blocked, not merely busy',
    severity: 'warning',
    // The distinction a human usually gets wrong, and it points at opposite
    // fixes: "busy" means add capacity, "blocked" means find the synchronous
    // call. High lag with LOW cpu is the tell — the process is not computing,
    // it is stuck inside one call.
    conclusion:
      'Event-loop lag is high while CPU is low. The process is not overloaded; something is '
      + 'holding the loop inside a synchronous call — PDF parsing, a large JSON stringify, '
      + 'or sync crypto. Adding capacity would not help.',
    triggers: [
      {
        key: 'lag_high',
        describe: (c) => `event-loop lag p99 is ${val(c, 'runtime', 'event_loop_lag_ms.p99')}ms`,
        test: (c) => {
          const l = num(val(c, 'runtime', 'event_loop_lag_ms.p99'));
          return l === null ? null : l >= 100;
        },
      },
      {
        key: 'cpu_low',
        describe: (c) => `CPU is only ${val(c, 'runtime', 'cpu_percent')}%`,
        test: (c) => {
          const cpu = num(val(c, 'runtime', 'cpu_percent'));
          return cpu === null ? null : cpu < 50;
        },
      },
    ],
    corroborating: [
      {
        key: 'requests_slow',
        weight: 3,
        describe: (c) => `API p95 is ${val(c, 'http', 'latency_ms.p95')}ms, consistent with requests queueing behind the loop`,
        test: (c) => {
          const p95 = num(val(c, 'http', 'latency_ms.p95'));
          const samples = num(val(c, 'http', 'samples'));
          if (p95 === null || samples === null) return null;
          // Not graded on a handful of requests — the same rule the http
          // collector applies to itself.
          if (samples < 20) return null;
          return p95 >= 1000;
        },
      },
    ],
    recommend: [],
    advice: 'Look for synchronous work on the request path rather than scaling the process.',
  },

  {
    id: 'database.connections_held',
    title: 'Connections are being held open, not merely used',
    severity: 'warning',
    conclusion:
      'Requests are waiting for a pool connection while transactions sit idle. That is a '
      + 'leaked transaction holding a connection, not traffic — more capacity would be '
      + 'consumed by the same leak.',
    triggers: [
      {
        key: 'pool_waiting',
        describe: (c) => `${val(c, 'database', 'pool.waiting')} requests are waiting for a connection`,
        test: (c) => {
          const w = num(val(c, 'database', 'pool.waiting'));
          return w === null ? null : w > 0;
        },
      },
      {
        key: 'idle_in_transaction',
        describe: (c) => `${val(c, 'database', 'connections.idle_in_transaction')} connections are idle in transaction`,
        test: (c) => {
          const n = num(val(c, 'database', 'connections.idle_in_transaction'));
          return n === null ? null : n > 0;
        },
      },
    ],
    corroborating: [
      {
        key: 'stale_transaction',
        weight: 4,
        describe: () => 'at least one transaction has been idle long enough to be considered stuck',
        test: (c) => {
          const t = val(c, 'database', 'stale_idle_in_transaction');
          if (t === null) return null;
          return Array.isArray(t) ? t.length > 0 : Boolean(t);
        },
      },
      {
        // The cross-card confirmation that the leak is REACHING users. A pool
        // with waiters and no effect on request latency is a capacity headroom
        // question; one that is slowing requests down is an incident. Same
        // metric, different urgency, and only the http card can tell them apart.
        key: 'requests_feeling_it',
        weight: 2,
        describe: (c) => `API p95 is ${val(c, 'http', 'latency_ms.p95')}ms, so requests are waiting on this`,
        test: (c) => {
          const p95 = num(val(c, 'http', 'latency_ms.p95'));
          const samples = num(val(c, 'http', 'samples'));
          if (p95 === null || samples === null || samples < 20) return null;
          return p95 >= 500;
        },
      },
    ],
    recommend: [],
    advice: 'Find the code path that opens a transaction and returns without committing or rolling back.',
  },

  {
    id: 'http.slow_because_database',
    title: 'The API is slow because the database is',
    severity: 'warning',
    // The anti-symptom-chasing rule. Both cards are amber; only one of them is
    // the cause, and without this the operator profiles the API for an hour.
    conclusion:
      'API latency and database latency are both elevated together. The API is the symptom. '
      + 'Time spent profiling request handlers will find the database at the bottom of it.',
    triggers: [
      {
        key: 'api_slow',
        describe: (c) => `API p95 is ${val(c, 'http', 'latency_ms.p95')}ms`,
        test: (c) => {
          const p95 = num(val(c, 'http', 'latency_ms.p95'));
          const samples = num(val(c, 'http', 'samples'));
          if (p95 === null || samples === null || samples < 20) return null;
          return p95 >= 1000;
        },
      },
      {
        key: 'database_slow',
        describe: (c) => `a trivial database round-trip takes ${val(c, 'database', 'latency_ms')}ms`,
        test: (c) => {
          const l = num(val(c, 'database', 'latency_ms'));
          return l === null ? null : l >= 200;
        },
      },
    ],
    corroborating: [
      {
        key: 'slow_queries',
        weight: 3,
        describe: () => 'pg_stat_statements is reporting slow statements',
        test: (c) => {
          const s = val(c, 'database', 'slow_queries');
          if (s === null) return null;
          return Array.isArray(s) && s.length > 0;
        },
      },
      {
        key: 'loop_not_blocked',
        weight: 2,
        describe: () => 'the event loop is healthy, so the slowness is not in this process',
        test: (c) => {
          const l = num(val(c, 'runtime', 'event_loop_lag_ms.p99'));
          return l === null ? null : l < 100;
        },
      },
    ],
    recommend: ['database.test'],
  },

  {
    id: 'ai.provider_degraded',
    title: 'The primary AI provider is degraded and traffic is falling back',
    severity: 'warning',
    conclusion:
      'A meaningful share of AI requests are being served by the fallback model. The primary '
      + 'is failing or timing out; answers are still being produced, at a different cost and '
      + 'quality than intended.',
    triggers: [
      {
        key: 'fallback_rate',
        describe: (c) => `${Math.round((num(val(c, 'ai', 'last_hour.fallback_rate')) ?? 0) * 100)}% of the last hour fell back`,
        test: (c) => {
          const r = num(val(c, 'ai', 'last_hour.fallback_rate'));
          return r === null ? null : r >= 0.2;
        },
      },
    ],
    corroborating: [
      {
        key: 'latency_up',
        weight: 3,
        describe: (c) => `average AI latency is ${val(c, 'ai', 'last_hour.avg_latency_ms')}ms`,
        test: (c) => {
          const l = num(val(c, 'ai', 'last_hour.avg_latency_ms'));
          return l === null ? null : l >= 5000;
        },
      },
      {
        // AI work is dispatched through BullMQ, so a provider slow enough to
        // matter shows up as its queue backing up. This is what separates
        // "the provider is degraded" from "we happen to be sending fewer
        // requests and the ratio looks bad" — a rate alone cannot tell you.
        key: 'ai_queue_backing_up',
        weight: 2,
        describe: () => 'the ai queue is accumulating work, consistent with slow upstream responses',
        test: (c) => {
          const qs = val(c, 'queues', 'queues');
          if (!Array.isArray(qs)) return null;
          const aiQ = qs.find((q) => q.name === 'ai');
          return aiQ ? (aiQ.waiting ?? 0) > 0 : null;
        },
      },
    ],
    recommend: ['ai.test'],
  },
];

module.exports = { RULES, pick, val, statusIs, num };
