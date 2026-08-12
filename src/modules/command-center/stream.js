// src/modules/command-center/stream.js
//
// Phase 3 — the Command Center's realtime transport.
//
// One WebSocket at `/api/command-center/stream`, one collect per tick shared by
// every connected operator, and a client that falls back to polling the moment
// this is unavailable. The render path on the client is identical either way:
// the frames carry exactly the payload the HTTP snapshot endpoint returns.
//
// ── The tick is shared, and it only runs while somebody is watching ──────────
//
// The naive version gives every socket its own interval, which turns two open
// browser tabs into two full collects per second against the database and the
// Redis instance the console exists to protect. Here there is ONE loop for the
// whole process; it starts when the first client connects and stops when the
// last one leaves. A console nobody has open costs nothing at all — which
// matters more than it sounds, because the alternative is a permanent
// background load added by an observability feature.
//
// ── Why setTimeout and not setInterval ───────────────────────────────────────
//
// A collect is bounded by the slowest collector's own timeout, which is 5s —
// well past the 1s tick. setInterval would queue ticks on top of a slow collect
// and pile more load onto a database that is already struggling, at precisely
// the moment the console is being watched. The loop re-arms only after the
// previous collect has finished, so a degraded system slows the stream down
// instead of being hammered by it.
//
// ── Backpressure ─────────────────────────────────────────────────────────────
//
// `ws.send()` buffers in memory when the peer cannot keep up. A phone on a bad
// connection with a 1s stream is the exact shape that grows that buffer without
// limit, so a client that is already behind is skipped rather than queued, and
// one that stays behind is disconnected. Dropping frames is correct for this
// data: every frame is a complete snapshot, so the next one supersedes whatever
// was skipped. There is nothing to catch up on.
'use strict';

const { WebSocketServer } = require('ws');
const logger = require('../../lib/logger');
const snapshot = require('./snapshot.service');
const tickets = require('./tickets');

/** The path nginx is configured to proxy with an Upgrade. Keep in sync with
 *  infra/nginx/myptstudio.conf. */
const PATH = '/api/command-center/stream';

const TICK_MS = Number(process.env.COMMAND_CENTER_STREAM_MS) || 1000;

/** Liveness. nginx holds the connection for an hour, so a peer that vanished
 *  without a FIN is invisible without an application-level ping. */
const PING_MS = 30_000;

/** This is an operator console for a handful of people, not a fan-out channel. */
const MAX_CLIENTS = 8;

/** Skip a client whose outbound buffer is past this. ~a dozen snapshots. */
const MAX_BUFFERED_BYTES = 512 * 1024;

/** Consecutive skipped ticks before the socket is considered gone. */
const MAX_CONSECUTIVE_SKIPS = 10;

/** Per-connection cooldown for the client's Refresh button. */
const REFRESH_COOLDOWN_MS = 2000;

/** Close codes. 4001–4999 is the application-defined range. */
const CLOSE = {
  UNAUTHORIZED: 4401,
  BUSY: 4429,
  SHUTTING_DOWN: 4503,
};

let wss = null;
let loopTimer = null;
let loopRunning = false;
let upgradeHandler = null;

// ── The tick ────────────────────────────────────────────────────────────────

function liveClients() {
  if (!wss) return [];
  return [...wss.clients].filter((ws) => ws.readyState === ws.OPEN);
}

function broadcast(frame) {
  const text = JSON.stringify(frame);
  for (const ws of liveClients()) {
    // A client that is behind gets nothing this tick. Frames are whole
    // snapshots, so skipping one loses no information.
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      ws._skips = (ws._skips || 0) + 1;
      if (ws._skips >= MAX_CONSECUTIVE_SKIPS) {
        logger.info({ skips: ws._skips }, 'Command Center stream: dropping a client that cannot keep up');
        ws.terminate();
      }
      continue;
    }
    ws._skips = 0;
    try { ws.send(text); } catch { /* the close handler will clean up */ }
  }
}

async function tick() {
  // Belt: snapshot.collect() is documented never to throw, and a rejection here
  // would end the loop for every connected operator during an incident.
  let data;
  try {
    data = await snapshot.collect();
  } catch (err) {
    logger.warn({ err: err.message }, 'Command Center stream: collect failed');
    broadcast({ type: 'error', message: 'Snapshot collection failed' });
    return;
  }
  broadcast({ type: 'snapshot', data });
}

function scheduleNext() {
  if (!loopRunning) return;
  loopTimer = setTimeout(async () => {
    if (!loopRunning) return;
    await tick();
    // Re-checked after the await: the last client may have left mid-collect.
    if (liveClients().length === 0) { stopLoop(); return; }
    scheduleNext();
  }, TICK_MS);
  // Never hold the process open for a stream.
  loopTimer.unref?.();
}

function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  logger.info({ tick_ms: TICK_MS }, 'Command Center stream: tick started');
  scheduleNext();
}

function stopLoop() {
  if (!loopRunning) return;
  loopRunning = false;
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
  logger.info('Command Center stream: tick stopped (no clients)');
}

// ── The handshake ───────────────────────────────────────────────────────────

/**
 * Reject an upgrade before the WebSocket exists.
 *
 * The client never sees this body — it sees a failed handshake — but the status
 * line is what shows up in nginx's log, which is where somebody debugging "the
 * console will not connect" will actually be looking.
 */
function refuse(socket, status, reason) {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  } catch { /* the peer is already gone */ }
  socket.destroy();
}

/**
 * Origin check — defence in depth, not the gate.
 *
 * A hostile page in the operator's browser cannot mint a ticket: the issuing
 * route is same-origin-only by CORS and its response is unreadable cross-origin.
 * This is here for the case where that reasoning turns out to be wrong. A
 * missing Origin (curl, a health probe, a native client) is allowed through to
 * the ticket check, which is the real authentication.
 */
function originAllowed(origin, allowedOrigins) {
  if (!origin) return true;
  if (!allowedOrigins || allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin);
}

function handleConnection(ws, operator) {
  ws._skips = 0;
  ws._lastRefresh = 0;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // The client has one thing to say. Anything else is ignored rather than
    // answered — an ops socket should not grow a command channel by accident,
    // and the commands that DO exist are POSTs behind the audited allow-list.
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || msg.type !== 'refresh') return;

    const now = Date.now();
    if (now - ws._lastRefresh < REFRESH_COOLDOWN_MS) return;
    ws._lastRefresh = now;

    snapshot.collect({ fresh: true })
      .then((data) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'snapshot', data }));
      })
      .catch(() => { /* the next tick will carry the state anyway */ });
  });

  ws.on('error', (err) => {
    logger.warn({ err: err.message }, 'Command Center stream: socket error');
  });

  ws.on('close', () => {
    if (liveClients().length === 0) stopLoop();
  });

  // The first frame is sent immediately rather than on the next tick: a console
  // that shows skeletons for a second after connecting looks slower than the
  // polling version it replaced.
  ws.send(JSON.stringify({
    type: 'hello',
    tick_ms: TICK_MS,
    operator: operator.email ?? null,
  }));
  snapshot.collect()
    .then((data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'snapshot', data }));
    })
    .catch(() => { /* the tick will follow */ });

  startLoop();
}

/**
 * Mount the stream on an existing http.Server.
 *
 * @param {import('http').Server} server
 * @param {{ allowedOrigins?: string[] }} [opts]
 */
function attach(server, opts = {}) {
  if (wss) return wss;

  wss = new WebSocketServer({
    noServer: true,
    // The client sends `{"type":"refresh"}` and nothing else. A small ceiling
    // means a hostile frame cannot allocate before it is rejected.
    maxPayload: 4 * 1024,
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* the close handler will clean up */ }
    }
  }, PING_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  upgradeHandler = (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://placeholder').pathname;
    } catch {
      return refuse(socket, 400, 'Bad Request');
    }

    // This process registers exactly one upgrade listener, so an unmatched path
    // has nobody else to fall through to; leaving the socket open would hang
    // the client until its own timeout.
    if (pathname !== PATH) return refuse(socket, 404, 'Not Found');

    const origin = req.headers.origin;
    if (!originAllowed(origin, opts.allowedOrigins)) {
      logger.warn({ origin }, 'Command Center stream: refused a disallowed origin');
      return refuse(socket, 403, 'Forbidden');
    }

    if (liveClients().length >= MAX_CLIENTS) {
      return refuse(socket, 503, 'Too Many Connections');
    }

    const ticket = new URL(req.url, 'http://placeholder').searchParams.get('ticket');
    const operator = tickets.redeem(ticket);
    if (!operator) {
      // Deliberately indistinguishable between "no ticket", "wrong ticket",
      // "already spent" and "expired": all four are the same event to a client
      // that should simply ask for a new one.
      return refuse(socket, 401, 'Unauthorized');
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      handleConnection(ws, operator);
    });
  };

  server.on('upgrade', upgradeHandler);
  logger.info({ path: PATH, tick_ms: TICK_MS }, 'Command Center stream mounted');
  return wss;
}

/** Shut the stream down. Safe to call when it was never attached. */
async function close(server) {
  stopLoop();
  if (server && upgradeHandler) server.off('upgrade', upgradeHandler);
  upgradeHandler = null;
  if (!wss) return;
  for (const ws of wss.clients) {
    try { ws.close(CLOSE.SHUTTING_DOWN, 'Server shutting down'); } catch { /* going away anyway */ }
  }
  await new Promise((resolve) => wss.close(resolve));
  wss = null;
}

module.exports = {
  attach,
  close,
  PATH,
  TICK_MS,
  MAX_CLIENTS,
  CLOSE,
  MAX_BUFFERED_BYTES,
  MAX_CONSECUTIVE_SKIPS,
  // Test seams.
  _originAllowed: originAllowed,
  _isLooping: () => loopRunning,
  _clientCount: () => liveClients().length,
  /** The SERVER's side of each open socket — the only way a test can simulate
   *  a peer that has stopped draining. */
  _clients: () => (wss ? [...wss.clients] : []),
};
