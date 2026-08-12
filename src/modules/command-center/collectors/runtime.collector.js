// src/modules/command-center/collectors/runtime.collector.js
//
// The health of THIS Node process: memory, CPU share, event-loop lag, GC.
//
// Distinct from the VPS collector, which reports the host. Both matter and they
// answer different questions — "is the box out of RAM" versus "is this process
// leaking". The brief's memory-leak example ("Backend memory increasing,
// possible leak in notification.service.js") is answered here.
//
// Event-loop lag is the headline number and the reason this file exists rather
// than just reading process.memoryUsage(). CPU percentage tells you the process
// is busy; loop lag tells you requests are already queueing behind it, which is
// what a user actually feels. monitorEventLoopDelay is a libuv-level histogram,
// so it costs effectively nothing and cannot itself be starved by a blocked
// loop the way a setInterval-based sampler can.
'use strict';

const v8 = require('v8');
const { monitorEventLoopDelay, PerformanceObserver } = require('perf_hooks');
const { STATUS, result } = require('../registry');

const NAME = 'runtime';

// Thresholds. Loop lag is in milliseconds at p99.
//  25ms  — noticeable on a busy endpoint
// 100ms  — the process is visibly stalling
const LAG_WARN_MS = Number(process.env.CC_LAG_WARN_MS) || 25;
const LAG_CRIT_MS = Number(process.env.CC_LAG_CRIT_MS) || 100;
// ── Heap, and the denominator that took 1,304 false alarms to notice ────────
//
// These are a fraction of `heap_size_limit` — what V8 will let this process
// grow to — NOT of `heapTotal`.
//
// `heapTotal` is the heap V8 has COMMITTED right now, and V8 deliberately keeps
// it close to the live set, growing it on demand up to the limit. So
// heapUsed/heapTotal is a measure of how tightly V8 is packing memory it has
// already reserved, and a HIGH value is the healthy case. It says nothing about
// how much room is left.
//
// Measured on an idle process at boot: heapUsed/heapTotal was 73% while
// heapUsed was 3.9MB against an 8,240MB limit — 0.0% of the way to
// out-of-memory. This collector alerted on the 73%.
//
// In production that shipped as "Heap 96% of allocated — close to
// out-of-memory", CRITICAL, 1,304 times over 19 hours, on a process that was
// fine the whole time. An alert that cries wolf 1,304 times is worse than no
// alert: it trains the operator to ignore the panel, including on the day the
// heap really is going.
const HEAP_WARN = 0.80;
const HEAP_CRIT = 0.92;

// ── Event-loop delay histogram ───────────────────────────────────────────────
// Started once at require time and never stopped. resolution:10 means it samples
// every 10ms, which is far finer than the 1s tick that reads it.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

// ── GC accounting ────────────────────────────────────────────────────────────
// A rising GC share with flat traffic is the signature of a leak: the process
// spends more and more time collecting and less doing work.
let gcTotalMs = 0;
let gcCount = 0;
let gcObserver = null;
try {
  gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcTotalMs += entry.duration;
      gcCount += 1;
    }
  });
  gcObserver.observe({ entryTypes: ['gc'] });
  // Without unref the observer's handle keeps Jest alive after the tests pass.
  if (typeof gcObserver.unref === 'function') gcObserver.unref();
} catch {
  // GC entries are not available on every build of Node. Not fatal — the card
  // simply reports gc: null rather than failing.
  gcObserver = null;
}

// CPU share needs two samples to mean anything: cpuUsage() is cumulative
// microseconds, so the interesting figure is the delta over wall time between
// two reads of this collector.
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

function cpuPercentSinceLastCall() {
  const now = Date.now();
  const usage = process.cpuUsage(lastCpu);
  const wallMs = now - lastCpuAt;
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  // First call after boot has no window to divide by.
  if (wallMs <= 0) return null;
  const cpuMs = (usage.user + usage.system) / 1000;
  // Can exceed 100 on a multi-core box: this is CPU time, not core occupancy.
  return Math.round((cpuMs / wallMs) * 1000) / 10;
}

function bytes(n) { return typeof n === 'number' ? n : null; }

async function collect() {
  const mem = process.memoryUsage();
  // getHeapStatistics() is a cheap synchronous read of counters V8 already
  // maintains; it is not a heap walk.
  const heapLimit = v8.getHeapStatistics().heap_size_limit || 0;
  // Of the limit — the distance to out-of-memory, and the only one that alerts.
  const heapRatio = heapLimit > 0 ? mem.heapUsed / heapLimit : 0;
  // Of what V8 has committed. Kept because it is genuinely useful for a
  // different question — how hard GC is working to pack what it holds — but it
  // is not an OOM signal and nothing branches on it.
  const committedRatio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;

  // Read then reset, so each tick reports the lag for ITS interval rather than
  // an average since boot that flattens every spike into invisibility.
  const lagP50 = loopDelay.percentile(50) / 1e6;
  const lagP99 = loopDelay.percentile(99) / 1e6;
  const lagMax = loopDelay.max / 1e6;
  loopDelay.reset();

  const data = {
    uptime_seconds: Math.round(process.uptime()),
    node_version: process.version,
    pid: process.pid,
    memory: {
      rss_bytes: bytes(mem.rss),
      heap_used_bytes: bytes(mem.heapUsed),
      heap_total_bytes: bytes(mem.heapTotal),
      external_bytes: bytes(mem.external),
      array_buffers_bytes: bytes(mem.arrayBuffers),
      // Of the LIMIT. This is the number that answers "how close are we to
      // falling over", and the one the status below is derived from.
      heap_used_ratio: Math.round(heapRatio * 1000) / 1000,
      // Of what V8 has committed. Informational; see the note by HEAP_WARN.
      heap_committed_ratio: Math.round(committedRatio * 1000) / 1000,
      // This used to be `constants?.NODE_PERFORMANCE_GC_FLAGS_NO ? null : null`
      // — a ternary returning null on both branches. Somebody knew the limit
      // was the interesting number and left a placeholder, and the ratio above
      // went on using the wrong denominator for want of this one line.
      heap_limit_bytes: heapLimit || null,
    },
    cpu_percent: cpuPercentSinceLastCall(),
    event_loop_lag_ms: {
      p50: Math.round(lagP50 * 100) / 100,
      p99: Math.round(lagP99 * 100) / 100,
      max: Math.round(lagMax * 100) / 100,
    },
    gc: gcObserver ? { total_ms: Math.round(gcTotalMs), collections: gcCount } : null,
    // Handles that never close are the other classic leak shape.
    active_handles: typeof process._getActiveHandles === 'function'
      ? process._getActiveHandles().length : null,
    active_requests: typeof process._getActiveRequests === 'function'
      ? process._getActiveRequests().length : null,
  };

  let status = STATUS.HEALTHY;
  let reason = null;
  if (lagP99 >= LAG_CRIT_MS) {
    status = STATUS.CRITICAL;
    reason = `Event-loop lag p99 ${data.event_loop_lag_ms.p99}ms — requests are queueing`;
  } else if (heapRatio >= HEAP_CRIT) {
    status = STATUS.CRITICAL;
    reason = `Heap ${Math.round(heapRatio * 100)}% of the ${Math.round(heapLimit / 1048576)}MB limit — close to out-of-memory`;
  } else if (lagP99 >= LAG_WARN_MS) {
    status = STATUS.WARNING;
    reason = `Event-loop lag p99 ${data.event_loop_lag_ms.p99}ms`;
  } else if (heapRatio >= HEAP_WARN) {
    status = STATUS.WARNING;
    reason = `Heap ${Math.round(heapRatio * 100)}% of the ${Math.round(heapLimit / 1048576)}MB limit`;
  }

  return result(NAME, { status, data, reason });
}

module.exports = { NAME, collect, LAG_WARN_MS, LAG_CRIT_MS, HEAP_WARN, HEAP_CRIT };
