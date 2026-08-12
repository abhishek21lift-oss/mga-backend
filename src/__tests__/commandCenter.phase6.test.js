// Command Center — Phase 6: the Alert Center.
//
// The collectors already detect problems. This layer exists to stop that
// detection turning into noise, so almost every test here is about something
// NOT happening:
//
//   * an `unavailable` card must not alert — a box with no Redis configured is
//     not an outage, and paging someone about it teaches them to ignore the
//     screen.
//   * one bad observation must not open an alert (a 3s probe timeout during a
//     deploy is not an incident), and one good one must not close it.
//   * a condition observed a thousand times must be ONE alert, announced ONCE.
//     SMTP here has been broken since launch; at a 60s tick the naive version
//     writes 1,440 rows a day about one fact.
//   * an alert about email must not be delivered BY email.
//
// The fake pool below models the table rather than stubbing each call, so the
// lifecycle assertions are real: open → escalate → acknowledge → resolve runs
// against state that actually changes.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

// ── A small in-memory stand-in for system_alerts ────────────────────────────
const mockDb = {
  alerts: [],
  notifications: [],
  superAdmins: [{ id: 'sa1', name: 'Ops', email: 'ops@myptstudio.com' }],
  seq: 0,
};

const mockSendRaw = jest.fn(async () => ({ sent: true, messageId: 'm1' }));
const mockIsConfigured = jest.fn(() => true);
const mockLogActivity = jest.fn(async () => {});
const mockCollect = jest.fn();

const mockPoolQuery = jest.fn(async (sql, params = []) => {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  const live = (fp) => mockDb.alerts.find((a) => a.fingerprint === fp && a.status !== 'resolved');

  if (/FROM users/.test(s) && /super_admin/.test(s)) {
    return { rows: mockDb.superAdmins.map((u) => ({ id: u.id, email: u.email })) };
  }
  if (/INSERT INTO notifications/.test(s)) {
    mockDb.notifications.push({ user_id: params[0], title: params[1], body: params[2], ref_id: params[3] });
    return { rows: [{ id: `n${mockDb.notifications.length}` }] };
  }
  if (/SELECT id, severity, notified_at FROM system_alerts/.test(s)) {
    const a = live(params[0]);
    return { rows: a ? [{ id: a.id, severity: a.severity, notified_at: a.notified_at }] : [] };
  }
  if (/INSERT INTO system_alerts/.test(s)) {
    // Models the partial unique index: an insert for a fingerprint that already
    // has a live row becomes an update, exactly as ON CONFLICT ... WHERE does.
    const existing = live(params[0]);
    if (existing) {
      existing.occurrences += 1;
      existing.reason = params[4];
      return { rows: [existing] };
    }
    mockDb.seq += 1;
    const row = {
      id: `a${mockDb.seq}`,
      fingerprint: params[0], source: params[1], severity: params[2],
      title: params[3], reason: params[4], snapshot: params[5],
      status: 'open', occurrences: 1, notified_at: null,
      resolved_at: null, resolution: null,
      acknowledged_at: null, acknowledged_by: null, acknowledged_by_name: null,
    };
    mockDb.alerts.push(row);
    return { rows: [row] };
  }
  // Each UPDATE branch is anchored on "UPDATE system_alerts SET". Matching on
  // the fragment alone let the counts query -- which contains the literal
  // status = 'acknowledged' inside a COUNT FILTER -- fall into the acknowledge
  // branch and return no rows.
  if (/^UPDATE system_alerts SET notified_at = NOW\(\)/.test(s)) {
    const a = mockDb.alerts.find((x) => x.id === params[0]);
    if (a) a.notified_at = new Date().toISOString();
    return { rows: a ? [a] : [] };
  }
  if (/^UPDATE system_alerts/.test(s) && /occurrences = occurrences \+ 1/.test(s)) {
    const a = mockDb.alerts.find((x) => x.id === params[0]);
    if (!a) return { rows: [] };
    a.occurrences += 1;
    a.reason = params[1];
    a.severity = params[2];
    if (params[3] === true) a.notified_at = null;   // escalation re-announces
    return { rows: [a] };
  }
  if (/^UPDATE system_alerts/.test(s) && /resolution = 'auto'/.test(s)) {
    const a = live(params[0]);
    if (!a) return { rows: [] };
    a.status = 'resolved'; a.resolution = 'auto'; a.resolved_at = new Date().toISOString();
    return { rows: [a] };
  }
  if (/^UPDATE system_alerts/.test(s) && /resolution = 'manual'/.test(s)) {
    const a = mockDb.alerts.find((x) => x.id === params[0] && x.status !== 'resolved');
    if (!a) return { rows: [] };
    a.status = 'resolved'; a.resolution = 'manual'; a.resolved_at = new Date().toISOString();
    return { rows: [a] };
  }
  if (/^UPDATE system_alerts/.test(s) && /SET status = 'acknowledged'/.test(s)) {
    const a = mockDb.alerts.find((x) => x.id === params[0] && x.status === 'open');
    if (!a) return { rows: [] };
    a.status = 'acknowledged';
    a.acknowledged_at = new Date().toISOString();
    a.acknowledged_by = params[1];
    a.acknowledged_by_name = params[2];
    return { rows: [a] };
  }
  if (/SELECT \* FROM system_alerts/.test(s)) {
    let rows = mockDb.alerts;
    if (/WHERE status <> 'resolved'/.test(s)) rows = rows.filter((a) => a.status !== 'resolved');
    else if (/WHERE status = 'resolved'/.test(s)) rows = rows.filter((a) => a.status === 'resolved');
    return { rows };
  }
  if (/COUNT\(\*\) FILTER/.test(s)) {
    return { rows: [{
      open: mockDb.alerts.filter((a) => a.status === 'open').length,
      acknowledged: mockDb.alerts.filter((a) => a.status === 'acknowledged').length,
      critical: mockDb.alerts.filter((a) => a.status !== 'resolved' && a.severity === 'critical').length,
      resolved_24h: mockDb.alerts.filter((a) => a.status === 'resolved').length,
    }] };
  }
  return { rows: [] };
});

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../db/pool', () => ({ query: mockPoolQuery }));
jest.mock('../lib/activityLog', () => ({ logActivity: mockLogActivity }));
jest.mock('../lib/email', () => ({ sendRaw: mockSendRaw, isConfigured: mockIsConfigured }));
jest.mock('../modules/command-center/snapshot.service', () => ({ collect: mockCollect }));

const alerts = require('../modules/command-center/alerts.service');
const { STATUS } = require('../modules/command-center/registry');

/** Build a snapshot with the given card statuses. */
function snapshotOf(cards) {
  return {
    status: 'critical',
    collected_at: new Date().toISOString(),
    duration_ms: 5,
    cards: Object.fromEntries(Object.entries(cards).map(([name, c]) => [
      name,
      typeof c === 'string'
        ? { name, status: c, data: null, latency_ms: 1, reason: c === STATUS.HEALTHY ? null : `${name} is ${c}`, checked_at: '' }
        : { name, latency_ms: 1, data: null, checked_at: '', ...c },
    ])),
  };
}

/** Run `n` evaluation passes against the same snapshot. */
async function observe(cards, n = 1) {
  let last;
  for (let i = 0; i < n; i++) {
    mockCollect.mockResolvedValueOnce(snapshotOf(cards));
    last = await alerts.evaluate();
  }
  return last;
}

const req = { user: { id: 'sa1', name: 'Ops' }, ip: '10.0.0.1', headers: {} };

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.alerts = [];
  mockDb.notifications = [];
  mockDb.seq = 0;
  mockIsConfigured.mockReturnValue(true);
  alerts._resetStreaks();
});

// ── What must not alert ─────────────────────────────────────────────────────
describe('what does not become an alert', () => {
  test('a healthy card never opens one', async () => {
    await observe({ redis: STATUS.HEALTHY }, 5);
    expect(mockDb.alerts).toHaveLength(0);
  });

  test('an UNAVAILABLE card never opens one, however long it persists', async () => {
    // Redis not configured, no Docker socket: a gap in observability, not an
    // outage. This is the same rule the console renders by, and getting it
    // wrong would page someone about a box that was never wired up.
    await observe({ redis: STATUS.UNAVAILABLE }, 10);
    expect(mockDb.alerts).toHaveLength(0);
    expect(mockDb.notifications).toHaveLength(0);
  });

  test('a single bad observation is not enough', async () => {
    // One tick of amber during a deploy is not an incident.
    await observe({ redis: STATUS.CRITICAL }, 1);
    expect(mockDb.alerts).toHaveLength(0);
  });

  test('and the streak must be CONSECUTIVE — a good reading resets it', async () => {
    // Otherwise a metric oscillating around a threshold accumulates its way to
    // an alert it never actually earned.
    await observe({ redis: STATUS.CRITICAL }, 1);
    await observe({ redis: STATUS.HEALTHY }, 1);
    await observe({ redis: STATUS.CRITICAL }, 1);
    expect(mockDb.alerts).toHaveLength(0);
  });
});

// ── Opening ─────────────────────────────────────────────────────────────────
describe('opening an alert', () => {
  test('opens once the condition persists, carrying the collector\'s own sentence', async () => {
    const out = await observe({ redis: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);

    expect(mockDb.alerts).toHaveLength(1);
    expect(out.opened).toHaveLength(1);
    const a = mockDb.alerts[0];
    expect(a.source).toBe('redis');
    expect(a.severity).toBe('critical');
    // Never paraphrased: the reason a card is red is written once, by the code
    // that knows why.
    expect(a.reason).toBe('redis is critical');
    expect(a.status).toBe('open');
  });

  test('a timeout alerts too — a probe that hangs usually means a sick dependency', async () => {
    await observe({ database: STATUS.TIMEOUT }, alerts.CONSECUTIVE_TO_OPEN);
    expect(mockDb.alerts[0].severity).toBe('timeout');
  });

  test('two sick collectors are two alerts, not one', async () => {
    await observe({ redis: STATUS.CRITICAL, smtp: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);
    expect(mockDb.alerts.map((a) => a.source).sort()).toEqual(['redis', 'smtp']);
  });
});

// ── Deduplication: the reason this module exists ────────────────────────────
describe('deduplication', () => {
  test('a persistent problem is ONE alert, announced ONCE, however many ticks', async () => {
    // The actual scenario: SMTP has been broken on this platform since launch.
    // 30 ticks is half an hour; the naive implementation would be 30 rows and
    // 30 notifications, and the Alert Center would be unusable within a day.
    await observe({ smtp: STATUS.CRITICAL }, 30);

    expect(mockDb.alerts).toHaveLength(1);
    expect(mockDb.alerts[0].occurrences).toBeGreaterThan(1);
    // One notification per super admin, for the one alert — not per tick.
    expect(mockDb.notifications).toHaveLength(mockDb.superAdmins.length);
  });

  test('the repeat observations still refresh the reason', async () => {
    await observe({ redis: { status: STATUS.WARNING, reason: 'memory 71%' } }, alerts.CONSECUTIVE_TO_OPEN);
    await observe({ redis: { status: STATUS.WARNING, reason: 'memory 88%' } }, 1);

    expect(mockDb.alerts).toHaveLength(1);
    expect(mockDb.alerts[0].reason).toBe('memory 88%');
  });
});

// ── Escalation ──────────────────────────────────────────────────────────────
describe('escalation', () => {
  test('warning -> critical updates the alert and announces again', async () => {
    await observe({ redis: STATUS.WARNING }, alerts.CONSECUTIVE_TO_OPEN);
    const afterOpen = mockDb.notifications.length;

    await observe({ redis: STATUS.CRITICAL }, 1);

    expect(mockDb.alerts).toHaveLength(1);              // still one alert
    expect(mockDb.alerts[0].severity).toBe('critical');
    // Getting worse is new information and is worth interrupting someone for.
    expect(mockDb.notifications.length).toBeGreaterThan(afterOpen);
  });

  test('critical -> warning updates quietly', async () => {
    await observe({ redis: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);
    const afterOpen = mockDb.notifications.length;

    await observe({ redis: STATUS.WARNING }, 3);

    expect(mockDb.alerts[0].severity).toBe('warning');
    // Improving is not worth a second interruption.
    expect(mockDb.notifications.length).toBe(afterOpen);
  });
});

// ── Auto-resolve ────────────────────────────────────────────────────────────
describe('auto-resolve', () => {
  test('a condition that fixes itself closes itself, marked auto', async () => {
    await observe({ redis: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);
    const out = await observe({ redis: STATUS.HEALTHY }, alerts.CONSECUTIVE_TO_CLEAR);

    expect(out.resolved).toHaveLength(1);
    expect(mockDb.alerts[0].status).toBe('resolved');
    // Distinguishable from a human closing it: a wall of MANUAL resolutions
    // means the detection is wrong, and that is only visible if the two differ.
    expect(mockDb.alerts[0].resolution).toBe('auto');
  });

  test('one good reading is NOT enough to close', async () => {
    await observe({ redis: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);
    await observe({ redis: STATUS.HEALTHY }, 1);

    expect(mockDb.alerts[0].status).toBe('open');
  });

  test('closing needs more evidence than opening', async () => {
    // Asymmetric on purpose: an alert that closes on the first green reading
    // and reopens on the next re-notifies every time it flaps.
    expect(alerts.CONSECUTIVE_TO_CLEAR).toBeGreaterThan(alerts.CONSECUTIVE_TO_OPEN);
  });

  test('an UNAVAILABLE reading counts as clear, not as an ongoing problem', async () => {
    // Redis alerting, then REDIS_URL is unset and the collector goes
    // unavailable. The alert must not be held open by a probe that stopped
    // running — nothing is being observed, so nothing is known to be wrong.
    await observe({ redis: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);
    await observe({ redis: STATUS.UNAVAILABLE }, alerts.CONSECUTIVE_TO_CLEAR);

    expect(mockDb.alerts[0].status).toBe('resolved');
  });

  test('resolving with nothing open is a no-op, not an error', async () => {
    const out = await observe({ redis: STATUS.HEALTHY }, alerts.CONSECUTIVE_TO_CLEAR + 2);
    expect(out.resolved).toHaveLength(0);
  });
});

// ── Channels ────────────────────────────────────────────────────────────────
describe('notification channels', () => {
  test('an alert ABOUT email is not delivered BY email', async () => {
    // The self-reference trap. Emailing "SMTP is down" is not merely futile:
    // the send fails, and on a platform where failed sends are themselves
    // observable it can feed the very condition it was reporting.
    await observe({ smtp: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);

    expect(mockSendRaw).not.toHaveBeenCalled();
    // The in-app channel still fired — the operator is told, just not by mail.
    expect(mockDb.notifications).toHaveLength(mockDb.superAdmins.length);
  });

  test('an alert about anything else does go by email', async () => {
    await observe({ redis: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);
    expect(mockSendRaw).toHaveBeenCalled();
  });

  test('in-app reaches every active platform operator', async () => {
    mockDb.superAdmins = [
      { id: 'sa1', name: 'A', email: 'a@x.com' },
      { id: 'sa2', name: 'B', email: 'b@x.com' },
    ];
    await observe({ redis: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);

    expect(mockDb.notifications.map((n) => n.user_id).sort()).toEqual(['sa1', 'sa2']);
    mockDb.superAdmins = [{ id: 'sa1', name: 'Ops', email: 'ops@myptstudio.com' }];
  });

  test('a failing email channel does not lose the alert', async () => {
    // The row in the table is the durable record; a channel is best-effort.
    // This is today's real state — SMTP has never delivered here.
    mockSendRaw.mockRejectedValueOnce(new Error('Connection timeout'));
    await observe({ redis: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);

    expect(mockDb.alerts).toHaveLength(1);
    expect(mockDb.alerts[0].notified_at).not.toBeNull();
  });

  test('unconfigured email is reported, not attempted', async () => {
    mockIsConfigured.mockReturnValue(false);
    const out = await alerts.notify({ id: 'a1', source: 'redis', severity: 'critical', title: 't', reason: 'r' });

    expect(mockSendRaw).not.toHaveBeenCalled();
    expect(out.email).toBe('not configured');
  });

  test('notify names the suppression reason rather than silently skipping', async () => {
    const out = await alerts.notify({ id: 'a1', source: 'smtp', severity: 'critical', title: 't', reason: 'r' });
    expect(out.email).toMatch(/suppressed/i);
  });
});

// ── The human lifecycle ─────────────────────────────────────────────────────
describe('acknowledge and resolve', () => {
  async function openOne() {
    await observe({ redis: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);
    return mockDb.alerts[0];
  }

  test('acknowledging records who, and is audited', async () => {
    const a = await openOne();
    const out = await alerts.acknowledge(a.id, req);

    expect(out.status).toBe('acknowledged');
    expect(out.acknowledged_by).toBe('sa1');
    expect(mockLogActivity).toHaveBeenCalledWith(
      req, 'command_center.alert.acknowledge', 'system_alert', a.id, expect.any(Object),
    );
  });

  test('acknowledging does NOT stop the alert tracking the condition', async () => {
    // Acknowledging is a statement about the operator, not about the system.
    const a = await openOne();
    await alerts.acknowledge(a.id, req);
    const before = a.occurrences;

    await observe({ redis: STATUS.CRITICAL }, 1);
    expect(mockDb.alerts[0].occurrences).toBeGreaterThan(before);
    expect(mockDb.alerts[0].status).toBe('acknowledged');
  });

  test('an acknowledged alert that fixes itself still auto-resolves', async () => {
    const a = await openOne();
    await alerts.acknowledge(a.id, req);
    await observe({ redis: STATUS.HEALTHY }, alerts.CONSECUTIVE_TO_CLEAR);

    expect(mockDb.alerts[0].status).toBe('resolved');
    expect(mockDb.alerts[0].resolution).toBe('auto');
  });

  test('acknowledging twice 404s rather than re-stamping', async () => {
    const a = await openOne();
    await alerts.acknowledge(a.id, req);
    await expect(alerts.acknowledge(a.id, req)).rejects.toMatchObject({ status: 404 });
  });

  test('a manual resolve is marked manual and audited', async () => {
    const a = await openOne();
    const out = await alerts.resolve(a.id, req);

    expect(out.resolution).toBe('manual');
    expect(mockLogActivity).toHaveBeenCalledWith(
      req, 'command_center.alert.resolve', 'system_alert', a.id, expect.any(Object),
    );
  });

  test('a manual resolve does not let the alert spring straight back', async () => {
    // Closing by hand fixes nothing — the condition is very likely still true.
    // The next observation must start the streak from zero and re-open
    // honestly, rather than reappearing on the very next tick.
    const a = await openOne();
    await alerts.resolve(a.id, req);

    await observe({ redis: STATUS.CRITICAL }, 1);
    expect(mockDb.alerts.filter((x) => x.status !== 'resolved')).toHaveLength(0);

    await observe({ redis: STATUS.CRITICAL }, 1);
    expect(mockDb.alerts.filter((x) => x.status !== 'resolved')).toHaveLength(1);
  });

  test('resolving an unknown id 404s', async () => {
    await expect(alerts.resolve('nope', req)).rejects.toMatchObject({ status: 404 });
  });

  test('a recurrence after a resolve opens a NEW alert, keeping the old in history', async () => {
    const a = await openOne();
    await alerts.resolve(a.id, req);
    await observe({ redis: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);

    expect(mockDb.alerts).toHaveLength(2);
    expect(mockDb.alerts.filter((x) => x.status === 'resolved')).toHaveLength(1);
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────
describe('list', () => {
  test('scopes to live by default and returns the badge counts alongside', async () => {
    await observe({ redis: STATUS.CRITICAL, smtp: STATUS.WARNING }, alerts.CONSECUTIVE_TO_OPEN);
    const out = await alerts.list();

    expect(out.alerts).toHaveLength(2);
    // Both in one call: the console polls this and would otherwise ask twice.
    expect(out.stats.open).toBe(2);
    expect(out.stats.critical).toBe(1);
  });

  test('resolved scope shows history', async () => {
    await observe({ redis: STATUS.CRITICAL }, alerts.CONSECUTIVE_TO_OPEN);
    await observe({ redis: STATUS.HEALTHY }, alerts.CONSECUTIVE_TO_CLEAR);

    expect((await alerts.list({ scope: 'live' })).alerts).toHaveLength(0);
    expect((await alerts.list({ scope: 'resolved' })).alerts).toHaveLength(1);
  });

  test('the limit is capped server-side', async () => {
    await alerts.list({ limit: 99999 });
    const call = mockPoolQuery.mock.calls.find(([sql]) => /SELECT \* FROM system_alerts/.test(sql));
    expect(call[1][0]).toBeLessThanOrEqual(500);
  });
});

// ── Robustness ──────────────────────────────────────────────────────────────
describe('the evaluator cannot take the process down', () => {
  test('a snapshot failure returns an empty result instead of rejecting', async () => {
    // It runs on a 60s interval. A rejection here would be an unhandled
    // rejection every minute for the life of the process.
    mockCollect.mockRejectedValueOnce(new Error('everything is on fire'));
    await expect(alerts.evaluate()).resolves.toMatchObject({ evaluated: 0 });
  });

  test('a database failure on one card does not stop the others', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('deadlock detected'));
    mockCollect.mockResolvedValueOnce(snapshotOf({ redis: STATUS.CRITICAL, smtp: STATUS.CRITICAL }));
    await expect(alerts.evaluate()).resolves.toBeTruthy();
  });
});
