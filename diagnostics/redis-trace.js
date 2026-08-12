// diagnostics/redis-trace.js
//
// ██ TEMPORARY DIAGNOSTIC — not loaded by the application. Delete when the
// ██ ECONNREFUSED 127.0.0.1:6379 investigation is closed.
//
// Answers one question: WHO is dialling loopback Redis?
//
// Run it instead of guessing:
//
//     node --require ./diagnostics/redis-trace.js src/server.js
//     npm run diagnose:redis           # same thing
//
// ── Why --require and not an import in server.js ────────────────────────────
//
// It must patch before ANY application module loads, because it works by
// replacing entries in require.cache. `--require` runs first by definition; an
// import inside server.js would already be too late for anything server.js
// requires above it — and Sentry (src/instrument.js) is required on line 8,
// which installs its own module hooks.
//
// ── Why three layers ────────────────────────────────────────────────────────
//
// Patching one client would be another hypothesis. The three layers are chosen
// so that nothing can slip between them:
//
//   1. net.Socket.prototype.connect  — the BACKSTOP, and the one that cannot
//      be evaded. Every outbound TCP connection in Node goes through it,
//      whatever library made it: ioredis, node-redis, an APM agent's own
//      probe, a transitive dependency nobody remembers adding. This layer
//      alone would answer the question.
//   2. ioredis constructor           — gives the RESOLVED options object, which
//      is what layer 1 cannot show you (by then it is just a host and a port).
//   3. node-redis createClient       — `redis@6` is in package.json. Nothing in
//      src/ requires it today, but it is installed, and its default is also
//      127.0.0.1:6379. Left uncovered it would be the next hypothesis.
//
// ── It does not change behaviour ────────────────────────────────────────────
//
// Every patch calls through to the original and returns its result unchanged.
// Nothing is swallowed, no option is rewritten, no error is suppressed. If the
// diagnostic itself throws, it catches and carries on — a debugging aid must
// never become the outage.
'use strict';

const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/** Only report loopback dials to this port. Everything else is noise. */
const WATCH_PORT = Number(process.env.REDIS_TRACE_PORT || 6379);

/** How many times to report the same stack before falling silent. */
const MAX_PER_SITE = Number(process.env.REDIS_TRACE_MAX || 3);

const seen = new Map();

function out(lines) {
  // process.stderr directly, never the app logger: the logger is itself
  // instrumented in this codebase and a diagnostic must not feed the thing it
  // is measuring.
  try { process.stderr.write(`${lines.join('\n')}\n`); } catch { /* never throw */ }
}

/**
 * The stack, trimmed to what identifies a caller.
 *
 * Frames inside this file are dropped. Application frames are marked `>>` so
 * the answer — the file and line in this repository — is findable without
 * reading twenty node_modules frames, while the library frames are kept
 * because they say WHICH library dialled (bullmq vs ioredis vs something else).
 */
function stackFrames() {
  const raw = new Error().stack || '';
  return raw
    .split('\n')
    .slice(1)
    .filter((l) => !l.includes('diagnostics/redis-trace.js'))
    .map((l) => {
      const t = l.trim();
      const isApp = t.includes(ROOT) && !t.includes('node_modules');
      return `${isApp ? '   >> ' : '      '}${t.replace(ROOT + '/', '')}`;
    })
    .slice(0, 24);
}

/** The first application frame — the answer, when there is one. */
function callerFile(frames) {
  const app = frames.find((f) => f.startsWith('   >> '));
  return app ? app.replace('   >> at ', '').trim() : '(no application frame — the caller is inside a dependency)';
}

function report(kind, detail, extra) {
  try {
    const frames = stackFrames();
    const caller = callerFile(frames);
    const key = `${kind}|${caller}`;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count > MAX_PER_SITE) return;

    out([
      '',
      '═'.repeat(78),
      `██ REDIS-TRACE  ${kind}  ->  ${detail}     (occurrence ${count})`,
      '═'.repeat(78),
      `CALLER : ${caller}`,
      ...(extra ? [`OPTIONS: ${extra}`] : []),
      'STACK  :',
      ...frames,
      '═'.repeat(78),
      '',
    ]);
  } catch { /* a diagnostic must never become the outage */ }
}

/** Options minus anything secret; this goes to a log. */
function safeOptions(o) {
  if (!o || typeof o !== 'object') return String(o);
  const clone = {};
  for (const [k, v] of Object.entries(o)) {
    if (/pass|secret|token|auth/i.test(k)) { clone[k] = '[redacted]'; continue; }
    if (typeof v === 'function') { clone[k] = '[function]'; continue; }
    if (v && typeof v === 'object') { clone[k] = Array.isArray(v) ? '[array]' : '[object]'; continue; }
    clone[k] = v;
  }
  return JSON.stringify(clone);
}

// ── Layer 1: every outbound TCP connection ──────────────────────────────────
//
// net.Socket.prototype.connect accepts either (options[, cb]) or
// (port[, host][, cb]). Both forms are handled; getting this wrong would make
// the backstop silently miss the very call it exists to catch.
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  try {
    let host;
    let port;
    // Three call shapes reach this method, and missing one makes the backstop
    // silently useless:
    //   socket.connect(port[, host][, cb])          direct
    //   socket.connect({host, port}[, cb])          direct, options form
    //   socket.connect([{host, port}, cb])          via net.connect /
    //                                               net.createConnection, which
    //                                               normalizes its arguments
    //                                               into an ARRAY first
    // The third cost this file a false negative in testing: args[0] was an
    // array, `args[0].port` was undefined, and the comparison quietly failed.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (first && typeof first === 'object') {
      host = first.host;
      port = first.port;
    } else {
      port = first;
      host = typeof args[1] === 'string' ? args[1] : undefined;
    }
    // Node defaults host to localhost when omitted — that omission IS the bug
    // shape we are hunting, so treat undefined as loopback rather than skipping.
    const effectiveHost = host === undefined ? 'localhost (defaulted)' : host;
    const isLoopback = host === undefined || LOOPBACK.has(String(host));

    if (isLoopback && Number(port) === WATCH_PORT) {
      report('TCP connect', `${effectiveHost}:${port}`, null);
    }
  } catch { /* never throw */ }

  return originalConnect.apply(this, args);
};

// ── Layer 2: ioredis, for the resolved options ──────────────────────────────
try {
  const ioredisPath = require.resolve('ioredis');
  const Original = require('ioredis');

  // A Proxy rather than a subclass: ioredis exports a class carrying a dozen
  // statics (Cluster, Command, ScanStream, defaultOptions …) that bullmq reads.
  // A subclass would need every one of them copied, and would break the day
  // ioredis adds another.
  const Patched = new Proxy(Original, {
    // ioredis re-exports the class as `.default` and `.Redis`, and bullmq
    // constructs through the former:
    //
    //   node_modules/bullmq/dist/cjs/classes/redis-connection.js:193
    //     new ioredis_1.default(rest)
    //
    // Without this trap those statics hand back the ORIGINAL class and every
    // BullMQ-created connection walks straight past the construct trap. The
    // first version of this file had exactly that hole; it was only visible
    // because the instrument was tested against the known bug before being
    // trusted with the unknown one.
    get(target, prop, receiver) {
      if (prop === 'default' || prop === 'Redis') return Patched;
      return Reflect.get(target, prop, receiver);
    },
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      try {
        const o = instance.options || {};
        if (LOOPBACK.has(String(o.host)) && Number(o.port) === WATCH_PORT) {
          report('new Redis()', `${o.host}:${o.port}`, safeOptions(o));
        }
      } catch { /* never throw */ }
      return instance;
    },
  });

  require.cache[ioredisPath].exports = Patched;
  out(['██ redis-trace: ioredis constructor patched']);
} catch (err) {
  out([`██ redis-trace: could not patch ioredis — ${err.message}`]);
}

// ── Layer 3: node-redis, which is installed even though src/ never calls it ─
try {
  const nodeRedisPath = require.resolve('redis');
  const original = require('redis');
  if (original && typeof original.createClient === 'function') {
    const realCreate = original.createClient.bind(original);
    original.createClient = function patchedCreateClient(opts, ...rest) {
      try {
        const url = opts && opts.url;
        const host = (opts && opts.socket && opts.socket.host) || (url ? new URL(url).hostname : undefined);
        const port = (opts && opts.socket && opts.socket.port) || (url ? Number(new URL(url).port) : WATCH_PORT);
        if (host === undefined || LOOPBACK.has(String(host))) {
          report('node-redis createClient()', `${host ?? 'localhost (defaulted)'}:${port}`, safeOptions(opts));
        }
      } catch { /* never throw */ }
      return realCreate(opts, ...rest);
    };
    require.cache[nodeRedisPath].exports = original;
    out(['██ redis-trace: node-redis createClient patched']);
  }
} catch {
  out(['██ redis-trace: node-redis not resolvable (fine — nothing requires it)']);
}

// ── What build is this? ─────────────────────────────────────────────────────
//
// Printed because "the fix is deployed" is itself an assumption. If the commit
// below is not the one carrying the fix, the logs are describing older code and
// no amount of tracing will explain them.
out([
  '██ redis-trace ACTIVE',
  `██   watching   : loopback:${WATCH_PORT}`,
  `██   REDIS_HOST : ${process.env.REDIS_HOST ?? '(unset)'}`,
  `██   REDIS_PORT : ${process.env.REDIS_PORT ?? '(unset)'}`,
  // REDIS_URL overrides REDIS_HOST in lib/redis.js. If it is set here and points
  // at loopback, the search is already over.
  `██   REDIS_URL  : ${process.env.REDIS_URL ? process.env.REDIS_URL.replace(/:\/\/[^@]*@/, '://[redacted]@') : '(unset)'}`,
  `██   NODE_ENV   : ${process.env.NODE_ENV ?? '(unset)'}`,
  `██   commit     : ${process.env.GIT_COMMIT || process.env.SOURCE_COMMIT || '(not stamped — see README)'}`,
  '',
]);
