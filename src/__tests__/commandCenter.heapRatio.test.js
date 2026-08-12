// Which denominator the heap alert uses.
//
// It used `heapTotal`, and that is not a mistake you catch by reading the line:
//
//     const heapRatio = mem.heapUsed / mem.heapTotal;
//
// It looks like "how full is the heap". It is not. `heapTotal` is the heap V8
// has COMMITTED, and V8 keeps that close to the live set on purpose, growing it
// on demand up to `heap_size_limit`. A high heapUsed/heapTotal is V8 packing
// tightly — the healthy case. Measured on an idle process at boot: 73%, with
// 3.9MB used against an 8,240MB limit.
//
// In production it shipped as "Heap 96% of allocated — close to
// out-of-memory", CRITICAL, 1,304 times in 19 hours, on a process that was fine
// throughout. That is the damage: an alert that is wrong 1,304 times teaches
// the operator to ignore the panel, including on the day it is right.
//
// These tests fix the denominator in place, because the wrong one is the
// plausible-looking one and it will look correct to the next reader too.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));

const v8 = require('v8');
const runtime = require('../modules/command-center/collectors/runtime.collector');

const MB = 1048576;

/** Pin both memory sources so the ratio is arithmetic, not weather. */
function withHeap({ usedMb, committedMb, limitMb }, fn) {
  const realMem = process.memoryUsage;
  const realStats = v8.getHeapStatistics;
  process.memoryUsage = () => ({
    rss: (committedMb + 40) * MB,
    heapUsed: usedMb * MB,
    heapTotal: committedMb * MB,
    external: 0,
    arrayBuffers: 0,
  });
  v8.getHeapStatistics = () => ({ heap_size_limit: limitMb * MB });
  return Promise.resolve()
    .then(fn)
    .finally(() => { process.memoryUsage = realMem; v8.getHeapStatistics = realStats; });
}

describe('the heap ratio is measured against the limit', () => {
  test('a nearly-full COMMITTED heap that is nowhere near the limit is healthy', async () => {
    // The exact shape that fired 1,304 times: 96% of committed, 0.6% of limit.
    await withHeap({ usedMb: 48, committedMb: 50, limitMb: 8240 }, async () => {
      const card = await runtime.collect();
      expect(card.data.memory.heap_committed_ratio).toBeCloseTo(0.96, 2);
      expect(card.data.memory.heap_used_ratio).toBeCloseTo(0.006, 3);
      expect(card.status).toBe('healthy');
      expect(card.reason).toBeNull();
    });
  });

  test('a heap genuinely near the limit is still CRITICAL', async () => {
    // The alert must not be defanged — only re-pointed. Committed is only 60%
    // full here, so the OLD code would have called this healthy: the two
    // denominators disagree in BOTH directions, and this is the direction that
    // costs you the process.
    await withHeap({ usedMb: 7700, committedMb: 12800, limitMb: 8240 }, async () => {
      const card = await runtime.collect();
      expect(card.data.memory.heap_committed_ratio).toBeCloseTo(0.60, 2);
      expect(card.status).toBe('critical');
      expect(card.reason).toMatch(/close to out-of-memory/);
    });
  });

  test('warns between the two thresholds', async () => {
    await withHeap({ usedMb: 6900, committedMb: 7000, limitMb: 8240 }, async () => {
      const card = await runtime.collect();
      expect(card.status).toBe('warning');
    });
  });

  test('the reason names the limit, so the number can be checked', async () => {
    // "96% of allocated" was unfalsifiable — allocated of what? Naming the
    // limit in megabytes is what let this bug be spotted from a screenshot.
    await withHeap({ usedMb: 7700, committedMb: 7800, limitMb: 8240 }, async () => {
      const card = await runtime.collect();
      expect(card.reason).toContain('8240MB limit');
    });
  });

  test('heap_limit_bytes is reported, not the null it used to be', async () => {
    // It was `constants?.NODE_PERFORMANCE_GC_FLAGS_NO ? null : null` — null on
    // both branches. Without it there was no way to check the ratio from the
    // console, which is why the wrong denominator survived so long.
    await withHeap({ usedMb: 40, committedMb: 50, limitMb: 8240 }, async () => {
      const card = await runtime.collect();
      expect(card.data.memory.heap_limit_bytes).toBe(8240 * MB);
    });
  });

  test('a missing heap limit degrades to healthy rather than dividing by zero', async () => {
    await withHeap({ usedMb: 40, committedMb: 50, limitMb: 0 }, async () => {
      const card = await runtime.collect();
      expect(card.data.memory.heap_used_ratio).toBe(0);
      expect(card.data.memory.heap_limit_bytes).toBeNull();
      expect(Number.isNaN(card.data.memory.heap_used_ratio)).toBe(false);
    });
  });
});
