// src/workers/whatsapp.worker.js
// BullMQ worker for the 'whatsapp' queue — one message per job so a single
// failure retries independently.
//
// Standalone:   node src/workers/whatsapp.worker.js
// In-process:   see src/workers/index.js

const { Worker } = require('bullmq');
const logger = require('../lib/logger');
const redis = require('../lib/redis');
const { processWhatsappJob } = require('../services/whatsapp.service');

function createWhatsappWorker() {
  const worker = new Worker('whatsapp', processWhatsappJob, {
    connection: redis.getWorkerConnection(),
    prefix: process.env.BULL_PREFIX || 'bull',
    concurrency: parseInt(process.env.WHATSAPP_WORKER_CONCURRENCY, 10) || 5,
  });

  worker.on('completed', (job) => logger.info({ jobId: job.id, type: job.name }, 'whatsapp job completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, type: job?.name, err: err.message }, 'whatsapp job failed'));
  worker.on('error', (err) => logger.error({ err: err.message }, 'whatsapp worker error'));

  return worker;
}

if (require.main === module) {
  const worker = createWhatsappWorker();
  logger.info('whatsapp worker started');
  const shutdown = async () => {
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createWhatsappWorker };
