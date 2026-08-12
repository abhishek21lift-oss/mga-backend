// Command Center — Phase 1: the collector harness.
//
// The property everything else rests on: ONE DEAD DEPENDENCY DEGRADES ONE CARD.
// An operations console is read during an incident, which is exactly when some
// dependency is down. A snapshot that throws, hangs, or 500s because Redis is
// unreachable is worse than no console — it removes the view at the moment the
// view is the point. So the harness must turn every failure into a renderable
// card, and these tests pin that rather than the individual metrics.
//
// The timeout test matters most. lib/queueHealth.js already learned this the
// hard way: BullMQ commands against an unreachable Redis sit in the offline
// queue and never settle, so a probe without its own deadline hangs forever.
'use strict';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const registry = require('../modules/command-center/registry');
const snapshot = require('../modules/command-center/snapshot.service');
const { STATUS } = registry;

beforeEach(() => {
  registry.clear();
  snapshot.invalidate();
});

describe('collector harness', () => {
  test('a healthy collector becomes a healthy card with its data', async () => {
    registry.register('ok', async () => ({ answer: 42 }));
    const snap = await snapshot.collect();

    expect(snap.status).toBe(STATUS.HEALTHY);
    expect(snap.cards.ok.data).toEqual({ answer: 42 });
    expect(typeof snap.cards.ok.latency_ms).toBe('number');
    expect(snap.cards.ok.checked_at).toEqual(expect.any(String));
  });

  test('a throwing collector becomes a critical card, and does not reject', async () => {
    registry.register('boom', async () => { throw new Error('socket closed'); });
    const snap = await snapshot.collect();

    expect(snap.cards.boom.status).toBe(STATUS.CRITICAL);
    // The message has to survive — "something failed" is not actionable at 3am.
    expect(snap.cards.boom.reason).toMatch(/socket closed/);
  });

  test('a hanging collector times out instead of hanging the snapshot', async () => {
    // Never settles — the BullMQ-against-dead-Redis shape.
    registry.register('hang', () => new Promise(() => {}), { timeoutMs: 50 });

    const started = Date.now();
    const snap = await snapshot.collect();

    expect(snap.cards.hang.status).toBe(STATUS.TIMEOUT);
    expect(snap.cards.hang.reason).toMatch(/50ms/);
    // Bounded by the collector's own deadline, not by the caller giving up.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('one dead collector does not stop the healthy ones reporting', async () => {
    registry.register('good', async () => ({ v: 1 }));
    registry.register('dead', async () => { throw new Error('down'); });
    registry.register('slow', () => new Promise(() => {}), { timeoutMs: 30 });

    const snap = await snapshot.collect();

    expect(snap.cards.good.status).toBe(STATUS.HEALTHY);
    expect(snap.cards.good.data).toEqual({ v: 1 });
    expect(snap.cards.dead.status).toBe(STATUS.CRITICAL);
    expect(snap.cards.slow.status).toBe(STATUS.TIMEOUT);
  });

  test('collectors run in parallel, not one after another', async () => {
    const slow = () => new Promise((r) => setTimeout(() => r({ ok: true }), 120));
    registry.register('a', slow);
    registry.register('b', slow);
    registry.register('c', slow);

    const started = Date.now();
    await snapshot.collect();

    // Serial would be ~360ms. Generous bound so a loaded CI box does not flake.
    expect(Date.now() - started).toBeLessThan(300);
  });

  test('a collector may set its own status and reason', async () => {
    registry.register('degraded', async () =>
      registry.result('degraded', { status: STATUS.WARNING, data: { x: 1 }, reason: 'latency 80ms' }));

    const snap = await snapshot.collect();
    expect(snap.cards.degraded.status).toBe(STATUS.WARNING);
    expect(snap.cards.degraded.reason).toBe('latency 80ms');
  });

  test('asking for an unknown card yields one unavailable card, not an error', async () => {
    registry.register('real', async () => ({}));
    const snap = await snapshot.collect({ only: ['real', 'imaginary'] });

    expect(snap.cards.real.status).toBe(STATUS.HEALTHY);
    expect(snap.cards.imaginary.status).toBe(STATUS.UNAVAILABLE);
  });
});

describe('status rollup', () => {
  test('critical beats everything', () => {
    expect(registry.rollup([STATUS.HEALTHY, STATUS.WARNING, STATUS.CRITICAL])).toBe(STATUS.CRITICAL);
  });

  test('unavailable does NOT outrank warning', () => {
    // A Docker socket that was never mounted is a gap in observability, not an
    // outage. If it outranked warning, every console on a box without the mount
    // would sit permanently amber and operators would stop reading the colour.
    expect(registry.rollup([STATUS.HEALTHY, STATUS.UNAVAILABLE])).toBe(STATUS.UNAVAILABLE);
    expect(registry.rollup([STATUS.WARNING, STATUS.UNAVAILABLE])).toBe(STATUS.WARNING);
  });

  test('a timeout outranks a warning', () => {
    // A probe that hangs usually means the thing behind it is genuinely sick.
    expect(registry.rollup([STATUS.WARNING, STATUS.TIMEOUT])).toBe(STATUS.TIMEOUT);
  });

  test('all healthy rolls up healthy', () => {
    expect(registry.rollup([STATUS.HEALTHY, STATUS.HEALTHY])).toBe(STATUS.HEALTHY);
  });
});

describe('per-collector cache', () => {
  test('a TTL collector is probed once within its window', async () => {
    let calls = 0;
    registry.register('cheap', async () => ({ calls: ++calls }), { ttlMs: 10_000 });

    await snapshot.collect();
    const second = await snapshot.collect();

    expect(calls).toBe(1);
    // Flagged, so the UI can show a latency number as stale rather than live.
    expect(second.cards.cheap.cached).toBe(true);
  });

  test('fresh=1 bypasses the cache', async () => {
    let calls = 0;
    registry.register('cheap', async () => ({ calls: ++calls }), { ttlMs: 10_000 });

    await snapshot.collect();
    await snapshot.collect({ fresh: true });

    expect(calls).toBe(2);
  });

  test('a zero-TTL collector is probed every time', async () => {
    // runtime is registered at ttl 0 on purpose: its event-loop histogram is
    // reset on read, so serving a cached copy would silently widen the window
    // each sample claims to cover.
    let calls = 0;
    registry.register('live', async () => ({ calls: ++calls }), { ttlMs: 0 });

    await snapshot.collect();
    await snapshot.collect();

    expect(calls).toBe(2);
  });
});

describe('registry guards', () => {
  test('registering the same name twice is refused', () => {
    registry.register('dup', async () => ({}));
    expect(() => registry.register('dup', async () => ({}))).toThrow(/already registered/);
  });

  test('a non-function collector is refused at registration, not at probe time', () => {
    expect(() => registry.register('bad', 'not a function')).toThrow(/must be a function/);
  });
});
