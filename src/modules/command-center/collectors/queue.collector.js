// src/modules/command-center/collectors/queue.collector.js
//
// BullMQ state, delegated entirely to lib/queueHealth.js.
//
// This file adds no Redis client and no Queue instance of its own — it calls
// collectQueueStats(), which already opens each queue through jobs/queue.js's
// registry and races every probe against a 2s timeout. Duplicating that here
// would mean a second set of BullMQ clients against a 256mb noeviction Redis,
// which is the specific thing §18 warns about.
//
// What this file DOES add is judgement. queueHealth reports counts; an operator
// needs to know which counts are a problem. The two that matter:
//
//   * waiting climbing while active stays flat  → workers are not draining.
//     This is the brief's "Redis latency increased because the worker queue is
//     growing" scenario, and it is the input the Guardian correlates on.
//   * failed climbing at all → jobs are being lost. For membership-renewals
//     that is a card charged with no membership row written, so it is graded
//     harder than the other queues.
'use strict';

const { STATUS, result, unavailable } = require('../registry');
const redis = require('../../../lib/redis');

const NAME = 'queues';

const WAITING_WARN = Number(process.env.CC_QUEUE_WAITING_WARN) || 50;
const WAITING_CRIT = Number(process.env.CC_QUEUE_WAITING_CRIT) || 250;
const FAILED_WARN = Number(process.env.CC_QUEUE_FAILED_WARN) || 1;
const FAILED_CRIT = Number(process.env.CC_QUEUE_FAILED_CRIT) || 25;

/** Losing one of these silently costs money or trust, so grade them harder. */
const CRITICAL_QUEUES = new Set(['membership-renewals']);

async function collect() {
  if (!redis.isConfigured()) {
    return unavailable(NAME, 'REDIS_URL is not set — queues run inline, nothing to drain');
  }

  const { collectQueueStats, summarize } = require('../../../lib/queueHealth');
  const stats = await collectQueueStats();
  const summary = summarize(stats);

  const queues = [];
  const problems = [];

  for (const [name, s] of Object.entries(stats || {})) {
    // queueHealth returns null for a queue it could not reach.
    if (!s) {
      queues.push({ name, reachable: false });
      problems.push({ severity: STATUS.CRITICAL, text: `Queue "${name}" unreachable` });
      continue;
    }

    const waiting = s.waiting ?? 0;
    const failed = s.failed ?? 0;
    const active = s.active ?? 0;
    const isCritical = CRITICAL_QUEUES.has(name);

    queues.push({
      name,
      reachable: true,
      waiting,
      active,
      delayed: s.delayed ?? 0,
      completed: s.completed ?? 0,
      failed,
      paused: Boolean(s.paused),
      // The signal the Guardian reads: work queued with nothing working it.
      starved: waiting > 0 && active === 0 && !s.paused,
    });

    if (waiting >= WAITING_CRIT) {
      problems.push({ severity: STATUS.CRITICAL, text: `${name}: ${waiting} jobs waiting` });
    } else if (waiting >= WAITING_WARN) {
      problems.push({ severity: STATUS.WARNING, text: `${name}: ${waiting} jobs waiting` });
    }

    // On a money queue a single failure is already worth a red card.
    const failCrit = isCritical ? 1 : FAILED_CRIT;
    if (failed >= failCrit) {
      problems.push({ severity: STATUS.CRITICAL, text: `${name}: ${failed} failed job(s)` });
    } else if (failed >= FAILED_WARN) {
      problems.push({ severity: STATUS.WARNING, text: `${name}: ${failed} failed job(s)` });
    }

    if (waiting > 0 && active === 0 && !s.paused) {
      problems.push({ severity: STATUS.WARNING, text: `${name}: ${waiting} waiting but nothing active — no worker draining` });
    }
    if (s.paused) {
      problems.push({ severity: STATUS.WARNING, text: `${name}: paused` });
    }
  }

  const worst = problems.some((p) => p.severity === STATUS.CRITICAL)
    ? STATUS.CRITICAL
    : problems.length ? STATUS.WARNING : STATUS.HEALTHY;

  return result(NAME, {
    status: worst,
    reason: problems.length ? problems.map((p) => p.text).join('; ') : null,
    data: {
      summary,
      queues,
      totals: queues.reduce((acc, q) => ({
        waiting: acc.waiting + (q.waiting || 0),
        active: acc.active + (q.active || 0),
        failed: acc.failed + (q.failed || 0),
      }), { waiting: 0, active: 0, failed: 0 }),
      problems,
    },
  });
}

module.exports = { NAME, collect, WAITING_WARN, WAITING_CRIT, FAILED_WARN, FAILED_CRIT, CRITICAL_QUEUES };
