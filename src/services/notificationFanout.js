// src/services/notificationFanout.js
// Enqueue one channel of a notification as its own BullMQ job on the
// 'notifications' queue. Called by notifications.service.js send().

const logger = require('../lib/logger');

const NOTIFICATION_CHANNELS = new Set(['inapp', 'email', 'whatsapp', 'sms', 'push']);

/**
 * Enqueue a single-channel notification job.
 *
 * Returns the BullMQ Job, or null when Redis is not ready so the caller can
 * fall back to the inline adapter. Never throws for a queue outage.
 */
async function enqueueNotification(channel, type, recipient, data, opts = {}) {
  if (!NOTIFICATION_CHANNELS.has(channel)) throw new Error(`Unknown notification channel: ${channel}`);

  const redis = require('../lib/redis');
  if (!(await redis.ensureReady())) return null;

  const { notificationsQueue } = require('../jobs/queue');
  const job = await notificationsQueue.add(`${channel}:${type}`, { ch: channel, type, recipient, data }, opts);
  logger.info({ jobId: job.id, channel, type, queue: 'notifications' }, 'notification job enqueued');
  return job;
}

module.exports = { enqueueNotification, NOTIFICATION_CHANNELS };
