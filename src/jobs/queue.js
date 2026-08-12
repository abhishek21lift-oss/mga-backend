// src/jobs/queue.js
// BullMQ queue catalogue for MY PT STUDIO.
//
// Every producer Queue shares ONE Redis connection — the singleton from
// lib/redis.js (getConnection()). Producers only issue non-blocking commands,
// so a single connection is safe and satisfies "no duplicate Redis
// connections". Workers each open their own blocking connection via
// lib/redis.js getWorkerConnection(); see lib/redis.js for why that is
// required rather than duplicated.
//
// Retry policy: every queue inherits DEFAULT_JOB_OPTIONS — bounded attempts
// with exponential backoff. Individual jobs may override (the membership
// renewal sweep, which touches payments, pins attempts: 1 so a retry can
// never double-charge; the interval re-runs the idempotent sweep instead).

const { Queue } = require('bullmq');
const logger = require('../lib/logger');
const redis = require('../lib/redis');

const QUEUE_NAMES = ['email', 'whatsapp', 'ai', 'notifications', 'membership-renewals'];

const DEFAULT_JOB_OPTIONS = {
  // Bounded retries with exponential backoff: 2s, 4s, 8s …
  attempts: parseInt(process.env.BULL_ATTEMPTS, 10) || 3,
  backoff: {
    type: 'exponential',
    delay: parseInt(process.env.BULL_BACKOFF_DELAY_MS, 10) || 2000,
  },
  // Completed jobs are cheap to keep around briefly (they hold the job data,
  // including anything the worker resolved); failures are kept longer so an
  // operator can inspect why something stopped being delivered.
  removeOnComplete: { count: parseInt(process.env.BULL_KEEP_COMPLETE, 10) || 1000, age: 24 * 3600 },
  removeOnFail: { count: parseInt(process.env.BULL_KEEP_FAILED, 10) || 5000, age: 7 * 24 * 3600 },
};

const _queues = {};

function getQueue(name) {
  if (!QUEUE_NAMES.includes(name)) {
    throw new Error(`Unknown queue: ${name}`);
  }
  if (!_queues[name]) {
    _queues[name] = new Queue(name, {
      connection: redis.getConnection(),
      prefix: process.env.BULL_PREFIX || 'bull',
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    _queues[name].on('error', (err) => {
      logger.error({ err: err.message, queue: name }, 'bull_queue_error');
    });
    logger.info({ queue: name }, 'BullMQ queue registered');
  }
  return _queues[name];
}

/**
 * Close every producer queue. Safe to call on shutdown: queues never close
 * the shared connection they were handed (BullMQ only closes connections it
 * created itself), so the caller closes lib/redis.js separately.
 */
async function closeAll() {
  await Promise.all(
    Object.values(_queues).map((q) => q.close().catch((err) => logger.warn({ err: err.message }, 'queue close failed')))
  );
  for (const k of Object.keys(_queues)) delete _queues[k];
}

module.exports = {
  getQueue,
  closeAll,
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  emailQueue: getQueue('email'),
  whatsappQueue: getQueue('whatsapp'),
  aiQueue: getQueue('ai'),
  notificationsQueue: getQueue('notifications'),
  membershipRenewalsQueue: getQueue('membership-renewals'),
};
