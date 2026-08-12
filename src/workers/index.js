// src/workers/index.js
// Start all in-process BullMQ workers plus the renewal scheduler.
//
// Used by server.js (when RUN_WORKERS != 0 and Redis is configured) so a
// single-instance Render deploy does not need a second worker process. Each
// worker owns its own blocking Redis connection — see lib/redis.js for why.
//
// Standalone:   node src/workers/index.js

const logger = require('../lib/logger');

let activeWorkers = [];

async function startWorkers() {
  const redis = require('../lib/redis');
  if (!redis.isConfigured()) {
    logger.warn('Redis not configured — in-process workers skipped');
    return [];
  }

  const { createEmailWorker } = require('./email.worker');
  const { createWhatsappWorker } = require('./whatsapp.worker');
  const { createAiWorker } = require('./ai.worker');
  const { createNotificationsWorker } = require('./notifications.worker');
  const { createRenewalWorker, scheduleRenewalCron } = require('./renewal.worker');

  const workers = [
    createEmailWorker(),
    createWhatsappWorker(),
    createAiWorker(),
    createNotificationsWorker(),
    createRenewalWorker(),
  ];
  await scheduleRenewalCron();

  activeWorkers = workers;
  logger.info({ count: workers.length }, 'in-process workers started');
  return workers;
}

async function stopWorkers() {
  await Promise.all(
    activeWorkers.map((w) => w.close().catch((err) => logger.warn({ err: err.message }, 'worker close failed')))
  );
  activeWorkers = [];
  logger.info('in-process workers stopped');
}

if (require.main === module) {
  // Command Center log persistence, standalone-worker half (D4).
  //
  // The worker runs in its own container, so it has its own in-memory ring that
  // nothing can read — the console is served by the API. Its errors reach an
  // operator ONLY through `system_logs`, which is exactly why those rows carry
  // a `source` column. Without this flush the worker would queue critical lines
  // and never write them, and the history would silently be API-only while
  // looking complete.
  //
  // No retention sweep here: one pruning process is enough, and the API's
  // hourly sweep covers every row regardless of who wrote it.
  const captureLogs = process.env.LOG_CAPTURE !== 'off';
  if (captureLogs) {
    const logCapture = require('../modules/command-center/logCapture');
    setInterval(() => { logCapture.flush(); }, 5 * 1000).unref();
  }

  startWorkers()
    .then(() => {
      const stop = async () => {
        // Flush once on the way out. The errors immediately PRECEDING a
        // shutdown are usually the interesting ones, and a 5s interval would
        // otherwise lose them with the process.
        if (captureLogs) {
          try {
            await require('../modules/command-center/logCapture').flush();
          } catch { /* shutting down; these lines are on stdout regardless */ }
        }
        await stopWorkers();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      logger.error({ err: err.message }, 'failed to start workers');
      process.exit(1);
    });
}

module.exports = { startWorkers, stopWorkers };
