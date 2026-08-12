// src/lib/queueHealth.js
// Shared queue-monitoring helpers for health probes and the super-admin
// /system-health dashboard.
//
// Every function here is defensive: an unhealthy queue must show up as a
// red/amber health field, never as a thrown error that makes the whole probe
// 500. Wrap each in try/catch at the call site (or use collectQueueStats,
// which does it for you).

const { QUEUE_NAMES } = require('../jobs/queue');
const logger = require('./logger');

// BullMQ commands on a client whose Redis is unreachable sit in the offline
// queue and never resolve (maxRetriesPerRequest: null). Every probe below is
// therefore raced against a timeout so a down queue shows as unhealthy rather
// than hanging the health endpoint or a test suite.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`queue health timeout: ${label}`)), ms);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

/**
 * Snapshot one queue. Returns null (and logs) if the queue cannot be reached
 * — the caller treats that as unhealthy rather than crashing.
 */
async function queueStats(name) {
  try {
    const { getQueue } = require('../jobs/queue');
    const queue = getQueue(name);
    const [waiting, active, delayed, completed, failed, paused] = await Promise.all([
      withTimeout(queue.getWaitingCount(), 2000, name),
      withTimeout(queue.getActiveCount(), 2000, name),
      withTimeout(queue.getDelayedCount(), 2000, name),
      withTimeout(queue.getCompletedCount(), 2000, name),
      withTimeout(queue.getFailedCount(), 2000, name),
      withTimeout(queue.isPaused(), 2000, name),
    ]);
    return {
      name,
      waiting,
      active,
      delayed,
      completed,
      failed,
      paused,
      // Queues that are full and draining nothing are the "amber" state; a
      // healthy operator metric is roughly "waiting is moving".
      backlog: waiting + delayed,
    };
  } catch (err) {
    logger.error({ err: err.message, queue: name }, 'queue_stats_failed');
    return null;
  }
}

/**
 * Snapshot every queue in parallel, omitting unreachable ones. When Redis is
 * not configured there is nothing to monitor, so it short-circuits instead of
 * waiting on connections that will never happen.
 */
async function collectQueueStats() {
  const redis = require('./redis');
  if (!redis.isConfigured()) return [];
  const results = await Promise.all(QUEUE_NAMES.map(queueStats));
  return results.filter(Boolean);
}

/** Human-readable summary for a health payload. */
function summarize(stats) {
  if (!Array.isArray(stats) || stats.length === 0) {
    return { status: 'unknown', detail: 'queues unreachable' };
  }
  const failed = stats.filter((s) => s === null).length;
  const backlog = stats.reduce((sum, s) => sum + (s.backlog || 0), 0);
  const status = backlog > 0 ? 'degraded' : 'healthy';
  return {
    status,
    queues: stats.length,
    unreachable: failed,
    backlog,
    counts: stats.reduce((acc, s) => {
      acc[s.name] = { waiting: s.waiting, active: s.active, delayed: s.delayed, failed: s.failed, paused: s.paused };
      return acc;
    }, {}),
  };
}

module.exports = { queueStats, collectQueueStats, summarize, QUEUE_NAMES };
