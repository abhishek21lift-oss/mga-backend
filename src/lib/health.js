const pool = require('../db/pool');
const redis = require('./redis');

async function getHealthPayload() {
  let dbState = 'disconnected';
  let redisState = 'disconnected';
  let errorMessage = null;

  try {
    await pool.query('SELECT 1');
    dbState = 'connected';
  } catch (err) {
    errorMessage = err.message;
  }

  try {
    await redis.ping();
    redisState = 'connected';
  } catch (err) {
    if (!errorMessage) {
      errorMessage = err.message;
    }
  }

  // Queue snapshot — defensive by construction (collectQueueStats never
  // throws): a down queue must appear as a health field, not as a probe that
  // crashes. Only meaningful when Redis is actually reachable.
  let queues = null;
  if (redisState === 'connected') {
    try {
      const { collectQueueStats, summarize } = require('./queueHealth');
      queues = summarize(await collectQueueStats());
    } catch (err) {
      queues = { status: 'unknown', detail: err.message };
    }
  }

  if (dbState === 'connected' && redisState === 'connected') {
    return {
      status: 'ok',
      version: 'v3',
      time: new Date().toISOString(),
      db: 'connected',
      redis: 'connected',
      queues,
    };
  }

  return {
    status: 'error',
    db: dbState,
    redis: redisState,
    queues,
    error: errorMessage,
  };
}

async function sendHealthResponse(req, res) {
  const payload = await getHealthPayload();

  if (payload.status === 'ok') {
    return res.json(payload);
  }

  return res.status(503).json(payload);
}

module.exports = {
  getHealthPayload,
  sendHealthResponse,
};
