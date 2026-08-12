// src/modules/command-center/logBuffer.js
//
// The hot half of D4: a bounded in-memory record of recent log lines.
//
// ── What this is and is not ─────────────────────────────────────────────────
//
// It is the CURRENT PROCESS since its last restart. It is not history, it is
// lossy on purpose, and after a deploy it is empty. Everything at `error` and
// above is additionally persisted to `system_logs` (migration 151), so the two
// halves cover different needs and neither pretends to be the other.
//
// Production runs two node processes in separate containers — `api` and
// `worker`. Each has its own ring, so a tail served by the API can only ever
// show the API's lines. The console says so; the persisted history is where the
// worker's errors are.
//
// ── The constraint that shapes every function here ──────────────────────────
//
// `record()` runs synchronously inside the logger, which means it runs on the
// request path of every API call that logs anything. It must be O(1), allocate
// almost nothing, and never throw. Anything cleverer — indexing, filtering on
// write, deduplication — belongs on the read side, which happens when an
// operator opens a panel and can afford it.
'use strict';

/**
 * 1000 lines is a few minutes of production chatter and well under a megabyte.
 * Overridable because a box under investigation may want a longer window, and
 * the cost of getting it wrong is bounded either way.
 */
const CAPACITY = Number(process.env.CC_LOG_RING_SIZE) || 1000;

const ring = new Array(CAPACITY);
let writeIndex = 0;
let total = 0;
let dropped = 0;

/** Pino's numeric levels. Kept as numbers so "at least error" is a comparison. */
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LABELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

function labelFor(level) {
  return LABELS[level] ?? String(level);
}

/**
 * Append one line.
 *
 * Overwrites the oldest entry when full, silently — that is what a ring is, and
 * counting the overwrite as a "drop" would report a fault where there is only a
 * design. `dropped` is reserved for lines the CAPTURE layer could not accept,
 * which is a real fault.
 *
 * @param {{time:number, level:number, msg:string, context?:object}} entry
 */
function record(entry) {
  ring[writeIndex] = entry;
  writeIndex = (writeIndex + 1) % CAPACITY;
  total += 1;
}

/** Called by the capture layer when it had to discard a line. */
function noteDropped(n = 1) { dropped += n; }

/**
 * Read the buffer, newest first.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.minLevel]  numeric floor, e.g. 40 for warn and above
 * @param {number}  [opts.limit=200]
 * @param {string}  [opts.q]         case-insensitive substring of the message
 * @param {number}  [opts.since]     epoch ms; only lines strictly newer
 */
function tail({ minLevel = 0, limit = 200, q = '', since = 0 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 200, 1), CAPACITY);
  const needle = String(q || '').toLowerCase();
  const out = [];

  // Walk backwards from the newest slot so the natural stopping point is
  // "enough lines", not "scanned the whole buffer".
  for (let i = 0; i < CAPACITY && out.length < capped; i++) {
    const idx = (writeIndex - 1 - i + CAPACITY * 2) % CAPACITY;
    const e = ring[idx];
    if (!e) continue;
    if (e.level < minLevel) continue;
    if (since && e.time <= since) continue;
    if (needle && !String(e.msg).toLowerCase().includes(needle)) continue;
    out.push(e);
  }

  return out;
}

/** Counts for the panel header, without shipping a thousand lines to get them. */
function stats() {
  const counts = { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 };
  let held = 0;
  let oldest = null;
  for (const e of ring) {
    if (!e) continue;
    held += 1;
    counts[labelFor(e.level)] = (counts[labelFor(e.level)] ?? 0) + 1;
    if (oldest === null || e.time < oldest) oldest = e.time;
  }
  return {
    held,
    capacity: CAPACITY,
    total_recorded: total,
    dropped,
    oldest_at: oldest ? new Date(oldest).toISOString() : null,
    counts,
  };
}

/** Tests only. */
function reset() {
  ring.fill(undefined);
  writeIndex = 0;
  total = 0;
  dropped = 0;
}

module.exports = { record, tail, stats, reset, noteDropped, labelFor, LEVELS, LABELS, CAPACITY };
