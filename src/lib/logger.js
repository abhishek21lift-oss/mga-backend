const pino = require('pino');

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

// ── Command Center log capture (Phase 8, decision D4) ───────────────────────
//
// Every line still goes to stdout exactly as before, and now additionally to an
// in-memory ring the console tails; lines at `error` and above are also batched
// into `system_logs`. Docker keeps collecting stdout, so `docker logs` is
// unaffected — this adds a reader, it does not move the output.
//
// Implemented as a pino multistream rather than by wrapping the logger's
// methods. Wrapping would miss anything logging through a child logger or
// through pino directly, and would put a function call in front of every log
// statement in the app. A second stream is the mechanism pino provides for
// exactly this, and it cannot change what stdout receives.
//
// This REPLACES the previous dev-only `transport: pino/file → fd 1`: pino
// cannot combine a transport with a custom destination, and that transport was
// writing to stdout anyway, so the output is unchanged either way.
//
// LOG_CAPTURE=off restores the original single-stream logger. This is the most
// widely required module in the app, and a change here should be revertible by
// an environment variable rather than a deploy.
const captureEnabled = process.env.LOG_CAPTURE !== 'off';

const options = {
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie',
      'body.password', 'body.currentPassword', 'body.newPassword', 'body.token',
      // L-04: redact PII fields that appear in request bodies and nested objects
      'body.email', 'body.mobile', 'body.phone', 'body.face_descriptor',
      '*.email', '*.mobile', '*.phone', '*.face_descriptor',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    req: (r) => ({
      method: r.method,
      url: r.url,
      query: r.query,
    }),
    res: (r) => ({
      statusCode: r.statusCode,
    }),
    err: pino.stdSerializers.err,
  },
};

let logger;

if (captureEnabled) {
  // Required here rather than at the top of the file to keep the dependency
  // one-way: logCapture reaches db/pool only inside its flush, which runs on a
  // timer long after this module has loaded. Requiring the pool at module scope
  // would be a cycle, because the pool logs.
  const { stream: captureStream } = require('../modules/command-center/logCapture');
  logger = pino(options, pino.multistream([
    { level: 'trace', stream: process.stdout },
    { level: 'trace', stream: captureStream },
  ]));
} else {
  logger = pino({
    ...options,
    transport: isProd ? undefined : { target: 'pino/file', options: { destination: 1 } },
  });
}

module.exports = logger;
