// Command Center — Phase 5: the operational commands.
//
// These are the buttons that touch production, so the tests are mostly about
// what must NOT happen:
//
//   * "Flush Cache" must never reach Redis. On this deployment Redis holds only
//     BullMQ, so the obvious implementation (FLUSHDB) is a data-loss bug that
//     would read as a cache miss. This is the single most important assertion
//     in the file.
//   * A destructive command must refuse a bare press. The confirmation is the
//     command's own NAME, which a click-through cannot satisfy.
//   * A rung of the recovery ladder that cannot run here must say so, not fail
//     obscurely at the point of use.
//   * Every run must be audited — success or failure. A failed restart is the
//     more interesting row.
//   * The queue name must come from the allow-list, never from the caller.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const mockQueueNames = ['email', 'whatsapp', 'ai', 'notifications', 'membership-renewals'];

// ── Doubles for everything the service can touch ────────────────────────────
// Each is a spy, so "did not touch Redis" is a real assertion rather than a
// hope that the code path was not taken.
const mockRedis = {
  isConfigured: jest.fn(() => true),
  ping: jest.fn(async () => 'PONG'),
  getClient: jest.fn(() => { throw new Error('commands must not take a raw Redis client'); }),
  flushdb: jest.fn(),
  flushall: jest.fn(),
};

const mockQueue = {
  pause: jest.fn(async () => {}),
  resume: jest.fn(async () => {}),
  getActiveCount: jest.fn(async () => 0),
  getWaitingCount: jest.fn(async () => 0),
  getFailedCount: jest.fn(async () => 3),
  getFailed: jest.fn(async () => []),
  clean: jest.fn(async () => []),
};

const mockGetQueue = jest.fn(() => mockQueue);
const mockLogActivity = jest.fn(async () => {});
const mockPoolQuery = jest.fn(async () => ({ rows: [{ db: 'myptstudio', version: 'PostgreSQL 16.2 on x86' }] }));
const mockVerifyConnection = jest.fn(async () => ({ ok: true }));
const mockSnapshotInvalidate = jest.fn();
const mockSnapshotCollect = jest.fn(async () => ({ cards: {} }));
const mockQueueCollect = jest.fn(async () => ({
  name: 'queues', status: 'healthy',
  data: { queues: [{ name: 'email', waiting: 0, active: 0, failed: 0 }] },
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../lib/redis', () => mockRedis);
jest.mock('../jobs/queue', () => ({ QUEUE_NAMES: mockQueueNames, getQueue: mockGetQueue }));
jest.mock('../lib/activityLog', () => ({ logActivity: mockLogActivity }));
jest.mock('../lib/email', () => ({ verifyConnection: mockVerifyConnection, isConfigured: () => true }));
jest.mock('../db/pool', () => ({
  query: mockPoolQuery, totalCount: 4, idleCount: 3, waitingCount: 0,
}));
jest.mock('../modules/command-center/snapshot.service', () => ({
  invalidate: mockSnapshotInvalidate,
  collect: mockSnapshotCollect,
}));
// One Click Recovery asks the queue COLLECTOR whether it worked, rather than
// keeping its own idea of "healthy". A recovery routine that disagreed with the
// console about whether it succeeded would be worse than no routine.
jest.mock('../modules/command-center/collectors/queue.collector', () => ({
  NAME: 'queues', collect: mockQueueCollect,
}));

const commands = require('../modules/command-center/commands.service');

const req = { user: { id: 'u1', name: 'Ops' }, ip: '10.0.0.1', headers: {} };

beforeEach(() => {
  jest.clearAllMocks();
  commands._resetCooldowns();
  mockRedis.isConfigured.mockReturnValue(true);
});

// ── The allow-list itself ───────────────────────────────────────────────────
describe('the allow-list', () => {
  test('an unknown command 404s before anything runs', async () => {
    await expect(commands.run('rm -rf /', { req })).rejects.toMatchObject({ status: 404 });
    // Nothing was attempted and — just as important — nothing was audited as an
    // action, because no action existed.
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockGetQueue).not.toHaveBeenCalled();
  });

  test('list() describes every command including the ones that cannot run', () => {
    const all = commands.list();
    const byName = Object.fromEntries(all.map((c) => [c.name, c]));

    // The ladder is described in full, so an operator can see rungs 4-5 exist.
    expect(byName['worker.restart'].unavailable_reason).toMatch(/docker/i);
    expect(byName['container.restart'].unavailable_reason).toMatch(/docker/i);
    // Every entry states its blast radius — this is what the confirm dialog shows.
    for (const c of all) expect(typeof c.blast_radius).toBe('string');
    // Destructive entries are flagged so the UI can gate them without a
    // hardcoded second list that could drift from this one.
    expect(byName['queue.clearFailed'].destructive).toBe(true);
    expect(byName['health.check'].destructive).toBe(false);
  });
});

// ── cache.flush: the one that would have been a data-loss bug ───────────────
describe('cache.flush', () => {
  test('clears the collector cache and never touches Redis', async () => {
    const out = await commands.run('cache.flush', { req });

    expect(mockSnapshotInvalidate).toHaveBeenCalled();
    expect(out.output.redis_touched).toBe(false);

    // The assertion that matters. Redis on this deployment is BullMQ's only
    // store, configured appendonly + noeviction precisely so a reboot does not
    // lose queued work; a FLUSHDB behind a "Flush Cache" button would throw
    // away every pending email and membership renewal.
    expect(mockRedis.flushdb).not.toHaveBeenCalled();
    expect(mockRedis.flushall).not.toHaveBeenCalled();
    expect(mockRedis.getClient).not.toHaveBeenCalled();
  });

  test('its description warns why Redis is left alone', () => {
    const c = commands.list().find((x) => x.name === 'cache.flush');
    expect(c.description).toMatch(/not touch redis/i);
  });
});

// ── Destructive confirmation ────────────────────────────────────────────────
describe('destructive commands', () => {
  test('refuse to run without the typed confirmation', async () => {
    await expect(commands.run('queue.clearFailed', { req, queue: 'email' }))
      .rejects.toMatchObject({ status: 428, code: 'CONFIRMATION_REQUIRED' });

    expect(mockQueue.clean).not.toHaveBeenCalled();
  });

  test('a generic "yes" is not enough — the confirmation is the command name', async () => {
    // The point of typing the name is that a click-through cannot produce it.
    // If any truthy confirm were accepted, the gate would be decoration.
    await expect(commands.run('queue.clearFailed', { req, queue: 'email', confirm: 'yes' }))
      .rejects.toMatchObject({ status: 428 });
    await expect(commands.run('queue.clearFailed', { req, queue: 'email', confirm: true }))
      .rejects.toMatchObject({ status: 428 });

    expect(mockQueue.clean).not.toHaveBeenCalled();
  });

  test('run with the exact name', async () => {
    const out = await commands.run('queue.clearFailed', {
      req, queue: 'email', confirm: 'queue.clearFailed',
    });
    expect(mockQueue.clean).toHaveBeenCalled();
    expect(out.outcome).toBe('ok');
  });

  test('a non-destructive command needs no confirmation', async () => {
    const out = await commands.run('queue.pause', { req, queue: 'email' });
    expect(out.outcome).toBe('ok');
    expect(mockQueue.pause).toHaveBeenCalled();
  });

  test('the refusal names the blast radius, so the prompt can quote it', async () => {
    const err = await commands.run('queue.clearFailed', { req, queue: 'email' }).catch((e) => e);
    expect(err.message).toMatch(/IRREVERSIBLE/);
  });
});

// ── Queue names come from the allow-list, not the caller ────────────────────
describe('queue selection', () => {
  test('an unknown queue name is a clean 400 that never reaches Redis', async () => {
    const err = await commands.run('queue.pause', { req, queue: 'bull:*' }).catch((e) => e);

    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Unknown queue/);
    // Validated before the queue is even resolved, so nothing is constructed
    // and no client-supplied string is handed to BullMQ.
    expect(mockGetQueue).not.toHaveBeenCalled();
    expect(mockQueue.pause).not.toHaveBeenCalled();
  });

  test('a rejected queue name does not burn the cooldown', async () => {
    // Otherwise a typo locks the operator out of the command they meant to run,
    // which is exactly when they are in a hurry.
    await commands.run('queue.pause', { req, queue: 'nope' }).catch(() => {});
    await expect(commands.run('queue.pause', { req, queue: 'email' })).resolves.toBeTruthy();
  });

  test('a missing queue name is rejected, not defaulted', async () => {
    const err = await commands.run('queue.pause', { req }).catch((e) => e);
    expect(err.status).toBe(400);
  });

  test('every declared queue is accepted', async () => {
    for (const name of mockQueueNames) {
      commands._resetCooldowns();
      await expect(commands.run('queue.pause', { req, queue: name })).resolves.toBeTruthy();
    }
    expect(mockGetQueue).toHaveBeenCalledTimes(mockQueueNames.length);
  });
});

// ── Unavailable rungs ───────────────────────────────────────────────────────
describe('capabilities absent on this deployment', () => {
  test('worker.restart returns the D6 reason as 503, not a crash', async () => {
    const err = await commands.run('worker.restart', {
      req, confirm: 'worker.restart',
    }).catch((e) => e);

    expect(err.status).toBe(503);
    expect(err.code).toBe('COMMAND_UNAVAILABLE');
    // The reason has to be actionable — it names the missing thing and where
    // the fix is written down.
    expect(err.message).toMatch(/docker\.sock/);
    expect(err.message).toMatch(/COMMAND-CENTER-PLAN/);
  });

  test('unavailability is checked before the confirmation gate', async () => {
    // Otherwise the operator types the name of a command that was never going
    // to run, and learns it was impossible only on the second press.
    const err = await commands.run('worker.restart', { req }).catch((e) => e);
    expect(err.status).toBe(503);
  });

  test('queue commands go unavailable when Redis is not configured', async () => {
    mockRedis.isConfigured.mockReturnValue(false);
    const err = await commands.run('queue.pause', { req, queue: 'email' }).catch((e) => e);

    expect(err.status).toBe(503);
    expect(commands.list().find((c) => c.name === 'queue.pause').unavailable_reason)
      .toMatch(/REDIS_URL/);
  });
});

// ── Auditing ────────────────────────────────────────────────────────────────
describe('auditing', () => {
  test('a successful run is audited with its outcome and duration', async () => {
    await commands.run('database.test', { req });

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const [gotReq, action, entityType, entityId, payload] = mockLogActivity.mock.calls[0];
    expect(gotReq).toBe(req);
    expect(action).toBe('command_center.database.test');
    expect(entityType).toBe('command_center');
    expect(entityId).toBe('database.test');
    expect(payload.outcome).toBe('ok');
    expect(typeof payload.duration_ms).toBe('number');
  });

  test('a FAILED run is audited too, with the error', async () => {
    // The row nobody wants to be missing during an incident.
    mockPoolQuery.mockRejectedValueOnce(new Error('connection refused'));

    await expect(commands.run('database.test', { req })).rejects.toThrow(/connection refused/);

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const payload = mockLogActivity.mock.calls[0][4];
    expect(payload.outcome).toBe('error');
    expect(payload.error).toMatch(/connection refused/);
  });

  test('an audit-write failure does not swallow the command result', async () => {
    mockLogActivity.mockRejectedValueOnce(new Error('activity_log unavailable'));
    const out = await commands.run('cache.flush', { req });
    expect(out.outcome).toBe('ok');
  });

  test('the destructive flag is recorded on the row', async () => {
    await commands.run('queue.retryFailed', {
      req, queue: 'email', confirm: 'queue.retryFailed',
    });
    expect(mockLogActivity.mock.calls[0][4].destructive).toBe(true);
  });
});

// ── Dry run and cooldown ────────────────────────────────────────────────────
describe('dry run', () => {
  test('describes the command without executing it or consuming the cooldown', async () => {
    const out = await commands.run('queue.pause', { req, queue: 'email', dryRun: true });

    expect(out.dry_run).toBe(true);
    expect(out.blast_radius).toMatch(/accumulate/i);
    expect(mockQueue.pause).not.toHaveBeenCalled();
    // A dry run is not an action, so it is not audited and does not start a
    // cooldown — otherwise previewing a command would block running it.
    expect(mockLogActivity).not.toHaveBeenCalled();

    await expect(commands.run('queue.pause', { req, queue: 'email' })).resolves.toBeTruthy();
  });

  test('a dry run of a destructive command still requires confirmation', async () => {
    // Preview is not a bypass: if dryRun skipped the gate, a client that always
    // sent dryRun:false after a successful preview would have skipped it too.
    await expect(commands.run('queue.clearFailed', { req, queue: 'email', dryRun: true }))
      .rejects.toMatchObject({ status: 428 });
  });
});

describe('cooldown', () => {
  test('a second press inside the window is refused with 429', async () => {
    await commands.run('smtp.test', { req });
    const err = await commands.run('smtp.test', { req }).catch((e) => e);

    expect(err.status).toBe(429);
    expect(err.code).toBe('COOLDOWN');
    // The probe ran exactly once — the double-click did not reach the provider.
    expect(mockVerifyConnection).toHaveBeenCalledTimes(1);
  });

  test('cooldowns are per command, not global', async () => {
    await commands.run('smtp.test', { req });
    await expect(commands.run('database.test', { req })).resolves.toBeTruthy();
  });
});

// ── One Click Recovery ──────────────────────────────────────────────────────
describe('recovery.run', () => {
  const confirm = 'recovery.run';

  test('is destructive and refuses a bare press', async () => {
    await expect(commands.run('recovery.run', { req, queue: 'email' }))
      .rejects.toMatchObject({ status: 428 });
    expect(mockQueue.pause).not.toHaveBeenCalled();
  });

  test('climbs the ladder in order: assess, pause, drain, resume, verify', async () => {
    const out = await commands.run('recovery.run', { req, queue: 'email', confirm });

    expect(out.output.steps.map((s) => s.step))
      .toEqual(['assess', 'pause', 'drain', 'resume', 'verify']);
    // Pause before drain, resume after — a drain that ran before the pause
    // would be waiting on a queue still accepting new work.
    expect(mockQueue.pause).toHaveBeenCalled();
    expect(mockQueue.resume).toHaveBeenCalled();
  });

  test('reports success when the queue comes back healthy', async () => {
    const out = await commands.run('recovery.run', { req, queue: 'email', confirm });
    expect(out.output.recovered).toBe(true);
    // Nothing further is proposed, because nothing further is needed.
    expect(out.output.next_rung).toBeNull();
  });

  test('when it does NOT recover, it names the next rung and says it cannot run it', async () => {
    // The honesty that makes the button trustworthy. Finishing at rung 3 and
    // reporting success would be the version an operator stops believing.
    mockQueueCollect.mockResolvedValue({
      name: 'queues', status: 'critical',
      data: { queues: [{ name: 'email', waiting: 500, active: 0, failed: 0 }] },
    });

    const out = await commands.run('recovery.run', { req, queue: 'email', confirm });

    expect(out.output.recovered).toBe(false);
    expect(out.output.next_rung.command).toBe('worker.restart');
    expect(out.output.next_rung.available).toBe(false);
    expect(out.output.next_rung.reason).toMatch(/docker\.sock/);

    mockQueueCollect.mockResolvedValue({
      name: 'queues', status: 'healthy',
      data: { queues: [{ name: 'email', waiting: 0, active: 0, failed: 0 }] },
    });
  });

  test('it asks the collector whether it worked, not itself', async () => {
    // Twice: once to assess, once to verify. Reusing the collector is what
    // stops "recovered" meaning something different here than on the card.
    await commands.run('recovery.run', { req, queue: 'email', confirm });
    expect(mockQueueCollect).toHaveBeenCalledTimes(2);
  });

  test('it still resumes the queue when the drain times out', async () => {
    // The failure that would turn a recovery button into an outage: pausing a
    // queue and leaving it paused because the drain gave up waiting.
    //
    // Fake timers rather than a real 30s wait — the drain bound is matched to
    // the worker's stop_grace_period and is not something to shorten for a
    // test, but neither is it something to sit through on every run.
    jest.useFakeTimers();
    mockQueue.getActiveCount.mockResolvedValue(3);

    const run = commands.run('recovery.run', { req, queue: 'email', confirm });
    await jest.advanceTimersByTimeAsync(35_000);
    const out = await run;

    expect(out.output.steps.find((s) => s.step === 'drain').drained).toBe(false);
    expect(mockQueue.resume).toHaveBeenCalled();

    jest.useRealTimers();
    mockQueue.getActiveCount.mockResolvedValue(0);
  });
});

// ── drainQueue ──────────────────────────────────────────────────────────────
describe('drainQueue', () => {
  test('returns as soon as nothing is active', async () => {
    mockQueue.getActiveCount.mockResolvedValueOnce(0);
    const out = await commands.drainQueue(mockQueue);
    expect(out.drained).toBe(true);
  });

  test('gives up at the timeout rather than hanging the request', async () => {
    // A job that never finishes must not hold the HTTP handler open forever.
    // 30s in production is matched to the worker's stop_grace_period; here a
    // short bound keeps the test honest and fast.
    mockQueue.getActiveCount.mockResolvedValue(2);
    const out = await commands.drainQueue(mockQueue, 50);

    expect(out.drained).toBe(false);
    expect(out.active).toBe(2);
  });
});
