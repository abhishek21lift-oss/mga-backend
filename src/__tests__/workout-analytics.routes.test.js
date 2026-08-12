// GET /workout-log/analytics and the landmark endpoints.
//
// The arithmetic is tested in training-analytics.test.js. What is left here is
// the part that only exists at the route: who is allowed to read a client's
// numbers, and whether a studio's own set ranges actually override the shared
// defaults rather than being quietly ignored.

const request = require('supertest');

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = global.__mockUser; next(); },
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
}));
jest.mock('../middleware/rbac', () => ({ requireRole: () => (_req, _res, next) => next() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));

const mockClientInOrg = jest.fn(async () => true);
jest.mock('../lib/orgGuard', () => ({ clientInOrg: (...a) => mockClientInOrg(...a) }));

const pool = require('../db/pool');

function app() {
  const express = require('express');
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/workout-log.routes'));
  return a;
}

const ORG = '11111111-1111-1111-1111-111111111111';
const sqls = () => pool.query.mock.calls.map(([s]) => String(s).replace(/\s+/g, ' '));
const find = (re) => sqls().find((s) => re.test(s));

beforeEach(() => {
  jest.clearAllMocks();
  mockClientInOrg.mockResolvedValue(true);
  global.__mockUser = { id: 'u-1', role: 'admin', organization_id: ORG };
  pool.query.mockResolvedValue({ rows: [] });
});

describe('GET /workout-log/analytics', () => {
  it('refuses a client outside the caller\'s studio before reading anything', async () => {
    mockClientInOrg.mockResolvedValue(false);
    await request(app()).get('/api/pt-os/workout-log/analytics?client_id=c-9').expect(404);
    // Not one query — a 404 that still ran the reads would have leaked timing
    // and load for another studio's client.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('requires a client id rather than reporting on everyone', async () => {
    await request(app()).get('/api/pt-os/workout-log/analytics').expect(400);
  });

  it('scopes every read to the caller organization', async () => {
    await request(app()).get('/api/pt-os/workout-log/analytics?client_id=c-1').expect(200);
    expect(find(/FROM workout_sessions ws WHERE ws\.client_id/)).toMatch(/ws\.organization_id = \$3/);
    expect(find(/FROM workout_sets s/)).toMatch(/ws\.organization_id = \$3/);
    expect(find(/FROM workout_assignments wa/)).toMatch(/wa\.organization_id = \$2/);
  });

  it('counts only completed sets as volume', async () => {
    // A planned-but-skipped set is not training. Counting it would tell a
    // trainer their client trained a muscle they walked past.
    await request(app()).get('/api/pt-os/workout-log/analytics?client_id=c-1').expect(200);
    expect(find(/GROUP BY e\.target_muscle/)).toMatch(/s\.completed = true/);
  });

  it('reads the plan\'s real training days, not its sessions_per_week label', async () => {
    // sessions_per_week is a number a trainer typed and can disagree with the
    // programme underneath it; the day rows cannot.
    await request(app()).get('/api/pt-os/workout-log/analytics?client_id=c-1').expect(200);
    const planSql = find(/FROM workout_assignments wa/);
    expect(planSql).toMatch(/DISTINCT we\.day_of_week/);
    expect(planSql).not.toMatch(/wp\.sessions_per_week/);
  });

  it('reports no adherence at all when the client has no active programme', async () => {
    // 0% would read as a client who never turns up. There is simply nothing to
    // be adherent to.
    const res = await request(app()).get('/api/pt-os/workout-log/analytics?client_id=c-1').expect(200);
    expect(res.body.data.adherence.pct).toBeNull();
    expect(res.body.data.plan).toBeNull();
    expect(res.body.data.this_week).toBeNull();
  });

  it('rejects a malformed as_of instead of passing it to a ::date cast', async () => {
    const res = await request(app())
      .get('/api/pt-os/workout-log/analytics?client_id=c-1&as_of=nope').expect(200);
    expect(res.body.data.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('clamps an absurd window rather than scanning everything', async () => {
    const res = await request(app())
      .get('/api/pt-os/workout-log/analytics?client_id=c-1&weeks=99999').expect(200);
    expect(res.body.data.weeks).toBeLessThanOrEqual(52);
  });
});

describe('landmarks', () => {
  it('prefers the studio row over the shared default', async () => {
    await request(app()).get('/api/pt-os/workout-log/landmarks').expect(200);
    const sql = find(/FROM muscle_volume_landmarks/);
    // DISTINCT ON with NULLS LAST is what expresses "mine, else the shared
    // one" in a single pass. Reversed, every studio would see the defaults
    // and their own edits would appear to save and do nothing.
    expect(sql).toMatch(/DISTINCT ON \(target_muscle\)/);
    expect(sql).toMatch(/ORDER BY target_muscle, organization_id NULLS LAST/);
  });

  it('writes a studio-owned row, never the shared default', async () => {
    pool.query.mockResolvedValue({ rows: [{ target_muscle: 'chest', mev_sets: 10, mrv_sets: 20 }] });
    await request(app()).put('/api/pt-os/workout-log/landmarks/chest')
      .send({ mev_sets: 10, mrv_sets: 20 }).expect(200);

    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toMatch(/INSERT INTO muscle_volume_landmarks/);
    // One studio's judgement must never become another's.
    expect(params).toContain(ORG);
  });

  it('refuses a minimum above the maximum', async () => {
    // Stored, it would render as a bar with negative width and a client
    // permanently "over" their own floor.
    const res = await request(app()).put('/api/pt-os/workout-log/landmarks/chest')
      .send({ mev_sets: 20, mrv_sets: 10 }).expect(400);
    expect(res.body.error.code).toBe('INVALID_RANGE');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('allows clearing a range — a blank is an honest answer', async () => {
    pool.query.mockResolvedValue({ rows: [{ target_muscle: 'neck', mev_sets: null, mrv_sets: null }] });
    await request(app()).put('/api/pt-os/workout-log/landmarks/neck')
      .send({ mev_sets: '', mrv_sets: '' }).expect(200);
    expect(pool.query.mock.calls[0][1]).toEqual(expect.arrayContaining([null]));
  });

  it('rejects a non-numeric value rather than storing NaN', async () => {
    await request(app()).put('/api/pt-os/workout-log/landmarks/chest')
      .send({ mev_sets: 'eight' }).expect(400);
  });

  it('refuses to write without a studio context', async () => {
    global.__mockUser = { id: 'u-0', role: 'super_admin', organization_id: null };
    await request(app()).put('/api/pt-os/workout-log/landmarks/chest')
      .send({ mev_sets: 8, mrv_sets: 20 }).expect(403);
  });
});

describe('DELETE /workout-log/landmarks/:muscle', () => {
  it('deletes only THIS studio\'s row', async () => {
    // Without organization_id in the WHERE this wipes the shared default for
    // every studio on the platform — from a button labelled "restore default".
    await request(app()).delete('/api/pt-os/workout-log/landmarks/chest').expect(200);
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toMatch(/DELETE FROM muscle_volume_landmarks/);
    expect(String(sql).replace(/\s+/g, ' ')).toMatch(/WHERE organization_id = \$1 AND target_muscle = \$2/);
    expect(params[0]).toBe(ORG);
  });

  it('hands back the shared default it just uncovered', async () => {
    // The point of the action is the number that comes BACK. Returning the
    // deletion alone would leave the editor showing the value it removed.
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ target_muscle: 'chest', mev_sets: 8, mrv_sets: 22, is_custom: false }] });
    const res = await request(app()).delete('/api/pt-os/workout-log/landmarks/chest').expect(200);
    expect(res.body.data).toMatchObject({ mev_sets: 8, mrv_sets: 22, is_custom: false });
  });

  it('copes with a muscle that has no shared default', async () => {
    // Some ship without one on purpose. "No range" is the correct answer, not
    // a 500 and not an invented pair of numbers.
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app()).delete('/api/pt-os/workout-log/landmarks/neck').expect(200);
    expect(res.body.data).toMatchObject({ mev_sets: null, mrv_sets: null, is_custom: false });
  });

  it('refuses without a studio context', async () => {
    global.__mockUser = { id: 'u-0', role: 'super_admin', organization_id: null };
    await request(app()).delete('/api/pt-os/workout-log/landmarks/chest').expect(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
