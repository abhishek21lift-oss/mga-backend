// src/services/whatsapp.service.js
// WhatsApp job orchestration: enqueue for background delivery (one message
// per job so a single failure is retried independently), and process a queued
// job in the whatsapp worker.

const logger = require('../lib/logger');

const WHATSAPP_TYPES = new Set(['text', 'template']);

/**
 * Enqueue a single WhatsApp message as a job.
 *
 * Returns the BullMQ Job, or null when Redis is not ready so the caller can
 * fall back to inline delivery. Never throws for a queue outage — that is
 * exactly the condition that must degrade to inline, not to a 500.
 */
async function enqueueWhatsapp(type, data = {}, opts = {}) {
  if (!WHATSAPP_TYPES.has(type)) throw new Error(`Unknown whatsapp job type: ${type}`);

  const redis = require('../lib/redis');
  if (!(await redis.ensureReady())) return null;

  const { whatsappQueue } = require('../jobs/queue');
  const job = await whatsappQueue.add(type, { type, ...data }, opts);
  logger.info({ jobId: job.id, type, queue: 'whatsapp' }, 'whatsapp job enqueued');
  return job;
}

/**
 * Worker processor: deliver one queued WhatsApp message. A delivery result of
 * status 'failed' throws so BullMQ retry/backoff applies; 'not_configured'
 * and 'sent' are terminal outcomes that must not be retried.
 */
async function processWhatsappJob(job) {
  const { type } = job.data || {};
  const { sendText, sendTemplate } = require('./whatsappDelivery');

  const deliver = type === 'template' ? sendTemplate : type === 'text' ? sendText : null;
  if (!deliver) throw new Error(`Unknown whatsapp job type: ${type}`);

  const res = await deliver(job.data);
  if (res.status === 'failed') {
    throw new Error(res.error || 'whatsapp delivery failed');
  }
  return res;
}

module.exports = { enqueueWhatsapp, processWhatsappJob, WHATSAPP_TYPES };
