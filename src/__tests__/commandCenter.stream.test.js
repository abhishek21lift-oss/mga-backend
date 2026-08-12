// Command Center — Phase 3: the realtime transport.
//
// This is the first thing in the product that authenticates something other
// than an Express request, so most of these tests are about the handshake
// rather than the data. In particular:
//
//   * A ticket must work exactly once. It travels in a query string, which
//     means it lands in nginx's access log; the whole reason that is
//     acceptable is that a logged ticket is already spent.
//   * An expired ticket must not be left behind in the store by a failed
//     redemption, or a replay leaves a live ticket where it found a dead one.
//   * The tick must not run when nobody is connected. An observability feature
//     that adds permanent background load to the database it observes has made
//     the system worse.
//   * The tick must be one loop for the whole process, not one per client. Two
//     open tabs must not double the collect rate.
//   * A client that cannot keep up must be skipped, not queued. Every frame is
//     a complete snapshot, so dropping one loses nothing — but buffering them
//     for a phone on a bad connection is an unbounded memory leak.
//
// A real http.Server and a real `ws` client are used throughout. The handshake
// is the thing under test and a mocked WebSocket would test the mock.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
// A short tick so the timing assertions do not make the suite slow.
process.env.COMMAND_CENTER_STREAM_MS = '60';

const http = require('http');
const WebSocket = require('ws');

const mockCollect = jest.fn(async () => ({
  status: 'healthy',
  collected_at: new Date().toISOString(),
  duration_ms: 1,
  cards: { runtime: { name: 'runtime', status: 'healthy', data: { pid: 1 } } },
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../modules/command-center/snapshot.service', () => ({
  collect: (...args) => mockCollect(...args),
  invalidate: jest.fn(),
}));

const tickets = require('../modules/command-center/tickets');
const stream = require('../modules/command-center/stream');

const OPERATOR = { id: 'usr_1', email: 'ops@myptstudio.com' };

// ── Harness ─────────────────────────────────────────────────────────────────

let server;
let port;

/**
 * Open a socket and resolve/reject on the handshake outcome.
 *
 * The message listener is attached at construction, NOT after the open event
 * resolves. The server's first frame is sent synchronously in the upgrade
 * callback and arrives in the same read as the handshake response, so `ws`
 * emits 'message' before the `await connect()` continuation gets to run — a
 * listener attached afterwards misses it entirely. Verified directly: at the
 * moment `await open` resumed, the frame had already been emitted.
 *
 * That is the product working as intended (the console must not show skeletons
 * for a tick after connecting), so the buffer belongs here rather than a delay
 * belonging in the server.
 */
function connect({ ticket, path = stream.PATH, origin } = {}) {
  const q = ticket === undefined ? '' : `?ticket=${encodeURIComponent(ticket)}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${q}`, {
    headers: origin ? { origin } : {},
  });
  ws.frames = [];
  ws.on('message', (raw) => {
    try { ws.frames.push(JSON.parse(String(raw))); } catch { /* not ours */ }
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    // `ws` surfaces a refused upgrade as an 'unexpected-response' event when the
    // server answered, and as 'error' otherwise. Both are failures here, but
    // only the first carries the status code the test wants to assert.
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
    });
    ws.once('error', (err) => reject(err));
  });
}

/** Poll a predicate until it holds. Returns false on timeout. */
async function waitUntil(pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

/** The next frame of the given type not yet consumed by this helper. */
async function nextFrame(ws, type) {
  const from = ws.consumed || 0;
  const found = await waitUntil(() => ws.frames.slice(from).some((f) => f.type === type));
  if (!found) throw new Error(`timed out waiting for a '${type}' frame`);
  const idx = ws.frames.findIndex((f, i) => i >= from && f.type === type);
  ws.consumed = idx + 1;
  return ws.frames[idx];
}

function countFrames(ws, type) {
  return ws.frames.filter((f) => f.type === type).length;
}

function closed(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', resolve);
  });
}

beforeAll(async () => {
  server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  stream.attach(server, { allowedOrigins: ['https://myptstudio.com'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await stream.close(server);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  tickets._clear();
  mockCollect.mockClear();
  // A client closing is not instantaneous from the server's side, and the
  // capacity and loop-lifecycle tests both assert on process-wide state. Wait
  // for the previous test's sockets to be reaped rather than assuming it.
  const quiet = await waitUntil(() => stream._clientCount() === 0 && !stream._isLooping());
  if (!quiet) throw new Error('the previous test left the stream running');
});

// ── Tickets ─────────────────────────────────────────────────────────────────

describe('tickets', () => {
  test('a ticket is redeemable exactly once', () => {
    const { ticket } = tickets.issue(OPERATOR);
    expect(tickets.redeem(ticket)).toEqual({ userId: 'usr_1', email: 'ops@myptstudio.com' });
    expect(tickets.redeem(ticket)).toBeNull();
  });

  test('an unknown or malformed ticket is refused without throwing', () => {
    expect(tickets.redeem('nope')).toBeNull();
    expect(tickets.redeem('')).toBeNull();
    expect(tickets.redeem(undefined)).toBeNull();
    expect(tickets.redeem(null)).toBeNull();
    expect(tickets.redeem({ ticket: 'object' })).toBeNull();
  });

  test('an expired ticket is refused AND removed, so a replay finds nothing', () => {
    const realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0;
    const { ticket } = tickets.issue(OPERATOR);

    // Past the window.
    Date.now = () => t0 + tickets.TTL_MS + 1;
    expect(tickets.redeem(ticket)).toBeNull();

    // Back inside it. If the failed redemption had left the record behind, the
    // ticket would come back to life here — which is the bug this guards.
    Date.now = () => t0;
    expect(tickets.redeem(ticket)).toBeNull();

    Date.now = realNow;
  });

  test('outstanding tickets are capped, evicting the oldest', () => {
    const first = tickets.issue(OPERATOR).ticket;
    for (let i = 0; i < tickets.MAX_OUTSTANDING; i += 1) tickets.issue(OPERATOR);
    expect(tickets._size()).toBeLessThanOrEqual(tickets.MAX_OUTSTANDING);
    expect(tickets.redeem(first)).toBeNull();
  });

  test('two tickets are never equal', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i += 1) seen.add(tickets.issue(OPERATOR).ticket);
    expect(seen.size).toBe(50);
  });
});

// ── The handshake ───────────────────────────────────────────────────────────

describe('handshake', () => {
  test('a valid ticket connects and the first snapshot arrives immediately', async () => {
    const { ticket } = tickets.issue(OPERATOR);
    const ws = await connect({ ticket });

    const hello = await nextFrame(ws, 'hello');
    expect(hello.operator).toBe('ops@myptstudio.com');
    expect(hello.tick_ms).toBe(60);

    const snap = await nextFrame(ws, 'snapshot');
    expect(snap.data.cards.runtime.status).toBe('healthy');

    ws.close();
    await closed(ws);
  });

  test('no ticket is refused with 401', async () => {
    await expect(connect()).rejects.toMatchObject({ status: 401 });
  });

  test('a garbage ticket is refused with 401', async () => {
    await expect(connect({ ticket: 'not-a-ticket' })).rejects.toMatchObject({ status: 401 });
  });

  test('a ticket already spent on one socket cannot open a second', async () => {
    const { ticket } = tickets.issue(OPERATOR);
    const ws = await connect({ ticket });
    await expect(connect({ ticket })).rejects.toMatchObject({ status: 401 });
    ws.close();
    await closed(ws);
  });

  test('another path on the same server is refused with 404, not left hanging', async () => {
    const { ticket } = tickets.issue(OPERATOR);
    await expect(connect({ ticket, path: '/api/something-else' }))
      .rejects.toMatchObject({ status: 404 });
  });

  test('a disallowed Origin is refused with 403 and does not spend the ticket', async () => {
    const { ticket } = tickets.issue(OPERATOR);
    await expect(connect({ ticket, origin: 'https://evil.example' }))
      .rejects.toMatchObject({ status: 403 });

    // The origin check runs BEFORE redemption, so the operator's ticket is
    // still good. Otherwise a hostile page could burn tickets to keep the real
    // console from connecting.
    const ws = await connect({ ticket, origin: 'https://myptstudio.com' });
    ws.close();
    await closed(ws);
  });

  test('the allowed Origin connects', async () => {
    const { ticket } = tickets.issue(OPERATOR);
    const ws = await connect({ ticket, origin: 'https://myptstudio.com' });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await closed(ws);
  });

  test('originAllowed permits a missing Origin — the ticket is the gate', () => {
    expect(stream._originAllowed(undefined, ['https://myptstudio.com'])).toBe(true);
    expect(stream._originAllowed('https://evil.example', ['https://myptstudio.com'])).toBe(false);
    // An unconfigured allow-list must not lock the operator out of their own
    // console; CORS is already unconfigured in that state too.
    expect(stream._originAllowed('https://anything', [])).toBe(true);
  });
});

// ── The tick ────────────────────────────────────────────────────────────────

describe('the tick', () => {
  test('does not run until a client connects, and stops when the last one leaves', async () => {
    expect(stream._isLooping()).toBe(false);

    const { ticket } = tickets.issue(OPERATOR);
    const ws = await connect({ ticket });
    await nextFrame(ws, 'snapshot');
    expect(stream._isLooping()).toBe(true);

    ws.close();
    await closed(ws);
    // The loop is torn down by the close handler, or by the tick noticing an
    // empty client list — allow one tick either way.
    expect(await waitUntil(() => !stream._isLooping())).toBe(true);
    expect(stream._clientCount()).toBe(0);
  });

  test('two clients share ONE collect per tick — the rate follows the clock, not the client count', async () => {
    // ── Why this is measured against elapsed time ─────────────────────────
    //
    // The obvious version of this test compares the collect count to the frames
    // one client received, and it is a tautology: every collect is broadcast to
    // every client, so frames-per-client equals the collect count no matter how
    // many loops are running. A deliberately broken build with one loop PER
    // CLIENT passed it. The property that actually distinguishes the two is the
    // rate — a shared loop collects once per tick however many people are
    // watching; per-client loops collect N times.
    const a = await connect({ ticket: tickets.issue(OPERATOR).ticket });
    const b = await connect({ ticket: tickets.issue(OPERATOR).ticket });
    await Promise.all([nextFrame(a, 'snapshot'), nextFrame(b, 'snapshot')]);

    // Both connections did their own immediate on-connect collect. Measure from
    // here, so what is counted is the tick and not the greeting.
    const beforeA = countFrames(a, 'snapshot');
    const beforeB = countFrames(b, 'snapshot');
    mockCollect.mockClear();

    const WINDOW_MS = 500;
    const startedAt = Date.now();
    await new Promise((r) => setTimeout(r, WINDOW_MS));
    const elapsed = Date.now() - startedAt;

    // Both are genuinely receiving the stream.
    expect(countFrames(a, 'snapshot') - beforeA).toBeGreaterThan(1);
    expect(countFrames(b, 'snapshot') - beforeB).toBeGreaterThan(1);

    // The loop re-arms only after the previous collect resolves, so the true
    // rate is at most one per TICK_MS. +1 for a tick straddling the window
    // edge. With two clients and one loop that is ~8 here; a loop per client
    // would be ~16 and blow straight through this.
    const maxTicks = Math.ceil(elapsed / 60) + 1;
    expect(mockCollect.mock.calls.length).toBeLessThanOrEqual(maxTicks);

    a.close(); b.close();
    await Promise.all([closed(a), closed(b)]);
  });

  test('a collect that rejects sends an error frame and keeps the stream alive', async () => {
    const ws = await connect({ ticket: tickets.issue(OPERATOR).ticket });
    await nextFrame(ws, 'snapshot');

    mockCollect.mockRejectedValueOnce(new Error('database is on fire'));
    const err = await nextFrame(ws, 'error');
    expect(err.message).toMatch(/failed/i);

    // Still streaming afterwards — one bad collect must not end the console.
    await nextFrame(ws, 'snapshot');

    ws.close();
    await closed(ws);
  });

  test('the refresh message forces a fresh collect, and is rate limited', async () => {
    const ws = await connect({ ticket: tickets.issue(OPERATOR).ticket });
    await nextFrame(ws, 'snapshot');

    mockCollect.mockClear();
    ws.send(JSON.stringify({ type: 'refresh' }));
    await new Promise((r) => setTimeout(r, 120));
    expect(mockCollect).toHaveBeenCalledWith({ fresh: true });

    // A second press inside the cooldown is dropped. Ticks keep calling
    // collect() with no argument, so count only the fresh ones.
    const freshBefore = mockCollect.mock.calls.filter((c) => c[0]?.fresh).length;
    ws.send(JSON.stringify({ type: 'refresh' }));
    await new Promise((r) => setTimeout(r, 120));
    const freshAfter = mockCollect.mock.calls.filter((c) => c[0]?.fresh).length;
    expect(freshAfter).toBe(freshBefore);

    ws.close();
    await closed(ws);
  });

  test('an unknown or malformed client message is ignored, not answered', async () => {
    const ws = await connect({ ticket: tickets.issue(OPERATOR).ticket });
    await nextFrame(ws, 'snapshot');

    mockCollect.mockClear();
    ws.send('not json at all');
    ws.send(JSON.stringify({ type: 'shutdown' }));
    ws.send(JSON.stringify({ type: 'refresh', extra: 'ignored' }));
    await new Promise((r) => setTimeout(r, 120));

    // Exactly one fresh collect: the refresh. The other two said nothing.
    expect(mockCollect.mock.calls.filter((c) => c[0]?.fresh)).toHaveLength(1);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await closed(ws);
  });
});

// ── Backpressure ────────────────────────────────────────────────────────────

describe('a peer that has stopped draining', () => {
  test('is skipped rather than buffered, and dropped if it never recovers', async () => {
    const ws = await connect({ ticket: tickets.issue(OPERATOR).ticket });
    await nextFrame(ws, 'snapshot');

    // The server's own handle for this socket. `bufferedAmount` is a live
    // getter over the outbound queue; overriding it is the only way to
    // simulate a phone on a bad connection without one.
    const [serverSide] = stream._clients();
    expect(serverSide).toBeDefined();
    Object.defineProperty(serverSide, 'bufferedAmount', {
      configurable: true,
      get: () => stream.MAX_BUFFERED_BYTES + 1,
    });

    const framesBefore = countFrames(ws, 'snapshot');

    // Long enough for more than MAX_CONSECUTIVE_SKIPS ticks at 60ms.
    const dropped = await waitUntil(() => ws.readyState === WebSocket.CLOSED, 3000);
    expect(dropped).toBe(true);

    // And not one frame was queued onto the socket in the meantime: skipping is
    // the point, because every frame is a whole snapshot and the next one
    // supersedes it. Buffering them is the memory leak this exists to prevent.
    expect(countFrames(ws, 'snapshot')).toBe(framesBefore);
  });
});

// ── Capacity ────────────────────────────────────────────────────────────────

describe('capacity', () => {
  test('the client cap is enforced with 503, and frees up on disconnect', async () => {
    const open = [];
    for (let i = 0; i < stream.MAX_CLIENTS; i += 1) {
      open.push(await connect({ ticket: tickets.issue(OPERATOR).ticket }));
    }

    await expect(connect({ ticket: tickets.issue(OPERATOR).ticket }))
      .rejects.toMatchObject({ status: 503 });

    open[0].close();
    await closed(open[0]);
    // The server's own view of the socket closing is not instantaneous.
    expect(await waitUntil(() => stream._clientCount() === stream.MAX_CLIENTS - 1)).toBe(true);

    const late = await connect({ ticket: tickets.issue(OPERATOR).ticket });
    expect(late.readyState).toBe(WebSocket.OPEN);

    for (const ws of [...open.slice(1), late]) ws.close();
    await Promise.all([...open.slice(1), late].map(closed));
  });
});
