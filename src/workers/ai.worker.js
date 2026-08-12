// src/workers/ai.worker.js
// BullMQ worker for the 'ai' queue: document ingestion and reindexing, the
// heavy CPU work that must never sit in a request path.
//
// Standalone:   node src/workers/ai.worker.js
// In-process:   see src/workers/index.js

const { Worker } = require('bullmq');
const logger = require('../lib/logger');
const redis = require('../lib/redis');
const { processAiJob } = require('../services/ai.service');

function createAiWorker() {
  const worker = new Worker('ai', processAiJob, {
    connection: redis.getWorkerConnection(),
    prefix: process.env.BULL_PREFIX || 'bull',
    // Embedding is CPU-bound (local transformers) — keep concurrency low so
    // one ingest does not starve the request path sharing this process.
    concurrency: parseInt(process.env.AI_WORKER_CONCURRENCY, 10) || 2,
  });

  worker.on('completed', (job) => logger.info({ jobId: job.id, type: job.name }, 'ai job completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, type: job?.name, err: err.message }, 'ai job failed'));
  worker.on('error', (err) => logger.error({ err: err.message }, 'ai worker error'));

  return worker;
}

if (require.main === module) {
  const worker = createAiWorker();
  logger.info('ai worker started');
  const shutdown = async () => {
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createAiWorker };
