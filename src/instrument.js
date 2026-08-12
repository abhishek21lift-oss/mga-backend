// src/instrument.js
// Sentry error monitoring — required first in server.js so the SDK can
// auto-instrument Express and pg. Completely inert unless SENTRY_DSN is set,
// so it is safe to deploy before the DSN env var exists.
require('dotenv').config();
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Off by default; set SENTRY_TRACES_SAMPLE_RATE (e.g. 0.1) to enable tracing.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    sendDefaultPii: false,
  });
}

module.exports = Sentry;
