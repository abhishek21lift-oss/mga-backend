// src/services/emailQueue.service.js
//
// Enqueue an email job onto the shared `email` queue.
//
// ── Why this no longer owns a Queue of its own ──────────────────────────────
//
// It used to require src/jobs/email.queue.js, which built a SECOND Queue for
// the same 'email' name with `connection: redis` — passing the lib/redis MODULE
// OBJECT where BullMQ expects an ioredis client or {host, port}. That object
// has no `host` key, so BullMQ built its own driver from nothing and ioredis
// fell back to its own default: 127.0.0.1:6379.
//
// On the VPS the API container has REDIS_HOST=redis and Redis runs in a
// separate container, so 127.0.0.1 is the API container's own loopback, where
// nothing listens. The result was a permanent ECONNREFUSED 127.0.0.1:6379 loop
// — three connections' worth per boot, since BullMQ opens client, subscriber
// and bclient — from a queue nothing used: the only caller is /api/debug, whose
// handler 404s in production. The require at server.js was unconditional, so
// the broken Queue was built on every boot regardless.
//
// The environment was never wrong. lib/redis.js reads REDIS_HOST correctly and
// its own DEFAULT_HOST is 'redis', so that file cannot emit a loopback address.
// One call site passed the wrong KIND of argument, and BullMQ cannot reject it.
//
// getQueue('email') in jobs/queue.js is the single owner of this queue: same
// name, same default prefix, and `connection: redis.getConnection()`. See
// bullmq.connections.test.js, which now fails the build if any BullMQ object is
// constructed with anything else.
'use strict';

const { getQueue } = require('../jobs/queue');

async function enqueueEmail(data) {
  return getQueue('email').add('send-email', data, {
    jobId: data?.id ? `email-${data.id}` : undefined,
  });
}

module.exports = enqueueEmail;
module.exports.enqueueEmail = enqueueEmail;
