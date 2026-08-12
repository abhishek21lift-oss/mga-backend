// src/workers/notifications.worker.js
// BullMQ worker for the 'notifications' queue. Processes the per-channel fan-
// out jobs produced by notifications.service.js send().
//
// Standalone:   node src/workers/notifications.worker.js
// In-process:   see src/workers/index.js

const { Worker } = require('bullmq');
const logger = require('../lib/logger');
const redis = require('../lib/redis');
const { processNotificationJob } = require('../modules/notifications/notifications.service');

function createNotificationsWorker() {
  const worker = new Worker('notifications', processNotificationJob, {
    connection: redis.getWorkerConnection(),
    prefix: process.env.BULL_PREFIX || 'bull',
    concurrency: parseInt(process.env.NOTIFICATIONS_WORKER_CONCURRENCY, 10) || 5,
  });

  worker.on('completed', (job) => logger.info({ jobId: job.id, name: job.name }, 'notification job completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'notification job failed'));
  worker.on('error', (err) => logger.error({ err: err.message }, 'notifications worker error'));

  return worker;
}

if (require.main === module) {
  const worker = createNotificationsWorker();
  logger.info('notifications worker started');
  const shutdown = async () => {
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createNotificationsWorker };
