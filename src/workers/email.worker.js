// src/workers/email.worker.js

const { Worker } = require('bullmq');
const logger = require('../lib/logger');
const redis = require('../lib/redis');
const { processEmailJob } = require('../services/email.service');

let worker;

function createEmailWorker() {
  if (worker) {
    return worker;
  }

  worker = new Worker('email', processEmailJob, {
    connection: redis.getWorkerConnection(),
    prefix: process.env.BULL_PREFIX || 'bull',
    concurrency: parseInt(process.env.EMAIL_WORKER_CONCURRENCY, 10) || 5,
  });

  worker.on('completed', (job) =>
    logger.info({ jobId: job.id, type: job.name }, 'email job completed')
  );

  worker.on('failed', (job, err) =>
    logger.error(
      { jobId: job?.id, type: job?.name, err: err.message },
      'email job failed'
    )
  );

  worker.on('error', (err) =>
    logger.error({ err: err.message }, 'email worker error')
  );

  return worker;
}

async function shutdown() {
  if (!worker) {
    return;
  }

  logger.info('Shutting down email worker');
  await worker.close();
}

if (require.main === module) {
  createEmailWorker();
  logger.info('email worker started');
}

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

module.exports = {
  createEmailWorker,
  shutdown,
};