// src/modules/command-center/logCapture.js
//
// The pino sink that feeds the ring and persists critical lines.
//
// ── The bug this file is mostly written to avoid ────────────────────────────
//
// Persisting error logs to the database means that when the database is
// unhealthy, the INSERT fails. The obvious thing to do with a failed INSERT is
// log an error. That error is at `error` level, so it is captured, so it is
// queued for insert, so it fails, so it logs an error.
//
// That is an unbounded loop that pins the CPU and floods the disk during
// exactly the incident you built the feature to investigate. Three separate
// guards, because one is not enough:
//
//   1. A re-entrancy flag around the flush, so a line emitted while flushing is
//      never itself queued.
//   2. Failures are reported to process.stderr DIRECTLY, never through the
//      logger. The logger is the thing that feeds this file.
//   3. The pending queue is bounded. If the database stays down, lines are
//      dropped and counted, not accumulated until the process runs out of heap.
//
// ── The other constraint ────────────────────────────────────────────────────
//
// `write()` is called synchronously by pino on every log line, on the request
// path. It parses one JSON line, pushes to a ring, and returns. The database
// write happens on a timer, batched. Nothing here awaits anything.
'use strict';

const { Writable } = require('stream');
const buffer = require('./logBuffer');

/** Only these reach Postgres. Everything reaches the ring. */
const PERSIST_FROM_LEVEL = 50;         // error and fatal

/** If the database is unreachable, stop growing at this many pending rows. */
const MAX_PENDING = 500;

/** How many rows one flush writes. Keeps a single statement small. */
const FLUSH_BATCH = 100;

/**
 * Which process this is. The worker container sets RUN_WORKERS=1, so the same
 * code in both containers labels its rows correctly with no extra config.
 */
const SOURCE = process.env.RUN_WORKERS === '1' ? 'worker' : 'api';

let pending = [];
let droppedPending = 0;
let flushing = false;
let persistEnabled = true;

/**
 * Fields pino puts at the top level that are represented by their own columns.
 * Everything else becomes `context`.
 */
const OWN_FIELDS = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v']);

/**
 * A defensive scrub over the parts of a line that reach a browser.
 *
 * lib/logger.js already redacts by path — authorization headers, passwords,
 * emails, mobiles. That covers structured fields. It does NOT cover a secret
 * that arrives inside a free-text message or an error string, and this feature
 * changes the exposure of those: a line that used to go to a VPS's stdout is
 * now stored in a table and rendered in a web page.
 *
 * So: connection strings lose their credentials, and bearer tokens and long
 * opaque keys are masked. Deliberately conservative — over-masking a log line
 * costs an operator one ssh; under-masking puts a live credential in a
 * database row and a browser tab.
 */
const SCRUBBERS = [
  // postgres://user:pass@host  →  postgres://user:[REDACTED]@host
  [/\b([a-z+]+:\/\/[^:\s/@]+):[^@\s]+@/gi, '$1:[REDACTED]@'],
  // Bearer tokens and JWTs.
  [/\bBearer\s+[\w-]+\.[\w-]+\.[\w-]+/gi, 'Bearer [REDACTED]'],
  [/\beyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g, '[REDACTED_JWT]'],
  // Provider keys that announce themselves by prefix.
  [/\b(sk|rk|re|whsec)_[A-Za-z0-9]{12,}/g, '$1_[REDACTED]'],
];

function scrub(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, replacement] of SCRUBBERS) out = out.replace(re, replacement);
  return out;
}

/** Scrub strings inside a shallow-ish context object without deep recursion cost. */
function scrubContext(value, depth = 0) {
  if (depth > 3) return value;
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubContext(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubContext(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * Handle one serialised pino line.
 *
 * Never throws: it is called from inside the logger, and an exception here
 * would propagate into whatever was being logged — turning a log statement
 * into a crash, which is the opposite of what logging is for.
 */
function accept(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON — something wrote to the stream directly. Keep it rather than
    // dropping it; an unparseable line during an incident is still evidence.
    buffer.record({ time: Date.now(), level: 30, msg: scrub(String(line).trim()), context: null });
    return;
  }

  const level = Number(parsed.level) || 30;
  const time = Number(parsed.time) || Date.now();
  const msg = scrub(String(parsed.msg ?? ''));

  const context = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!OWN_FIELDS.has(k)) context[k] = v;
  }
  const scrubbed = Object.keys(context).length ? scrubContext(context) : null;

  buffer.record({ time, level, msg, context: scrubbed });

  if (!persistEnabled || level < PERSIST_FROM_LEVEL) return;

  // GUARD 1: a line emitted while flushing is never queued. Without this, the
  // failure path of the flush feeds itself.
  if (flushing) return;

  // GUARD 3: bounded. A database that stays down costs a fixed amount of heap
  // and a counter, not an OOM.
  if (pending.length >= MAX_PENDING) {
    droppedPending += 1;
    buffer.noteDropped(1);
    return;
  }

  pending.push({
    level,
    level_label: buffer.labelFor(level),
    logged_at: new Date(time).toISOString(),
    msg,
    source: SOURCE,
    pid: parsed.pid ?? null,
    hostname: parsed.hostname ?? null,
    context: scrubbed,
  });
}

/** The stream handed to pino. */
const stream = new Writable({
  write(chunk, _enc, cb) {
    try { accept(chunk.toString()); } catch { /* never break the logger */ }
    cb();
  },
});

/**
 * Write queued critical lines to Postgres.
 *
 * Called on an interval, never inline. Resolves with what it did rather than
 * throwing, so the caller's `.catch` is a formality rather than the control
 * flow.
 */
async function flush() {
  if (flushing || pending.length === 0) return { written: 0 };

  flushing = true;                       // GUARD 1
  const batch = pending.slice(0, FLUSH_BATCH);
  pending = pending.slice(batch.length);

  try {
    const pool = require('../../db/pool');
    // One statement for the batch. A row-per-INSERT would multiply round trips
    // at exactly the moment the database is the thing under strain.
    const values = [];
    const params = [];
    batch.forEach((r, i) => {
      const b = i * 8;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
      params.push(
        r.level, r.level_label, r.logged_at, r.msg,
        r.source, r.pid, r.hostname,
        r.context ? JSON.stringify(r.context) : null,
      );
    });

    await pool.query(
      `INSERT INTO system_logs
         (level, level_label, logged_at, msg, source, pid, hostname, context)
       VALUES ${values.join(',')}`,
      params,
    );
    return { written: batch.length };
  } catch (err) {
    // GUARD 2: straight to stderr. Calling logger.error here is the loop.
    process.stderr.write(
      `[command-center] could not persist ${batch.length} log lines: ${err.message}\n`,
    );
    return { written: 0, error: err.message };
  } finally {
    flushing = false;
  }
}

/**
 * Delete rows older than the retention window.
 * @returns the number removed.
 */
async function prune(days = Number(process.env.LOG_RETENTION_DAYS) || 30) {
  try {
    const pool = require('../../db/pool');
    const { rowCount } = await pool.query(
      `DELETE FROM system_logs WHERE logged_at < NOW() - ($1 || ' days')::interval`,
      [String(Math.max(1, days))],
    );
    return rowCount ?? 0;
  } catch (err) {
    process.stderr.write(`[command-center] log retention sweep failed: ${err.message}\n`);
    return 0;
  }
}

function stats() {
  return {
    source: SOURCE,
    pending: pending.length,
    pending_capacity: MAX_PENDING,
    dropped_pending: droppedPending,
    persist_from_level: PERSIST_FROM_LEVEL,
    persist_enabled: persistEnabled,
  };
}

/** Tests only. */
function _reset({ persist = true } = {}) {
  pending = [];
  droppedPending = 0;
  flushing = false;
  persistEnabled = persist;
  buffer.reset();
}

module.exports = {
  stream, accept, flush, prune, stats, scrub, _reset,
  PERSIST_FROM_LEVEL, MAX_PENDING, FLUSH_BATCH, SOURCE,
};
