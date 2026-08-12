// Version snapshots: freezing what a programme USED to say.
//
// The thing worth protecting here is subtle. A client's history is already
// safe — workout_sessions and workout_sets record what was performed and no
// plan edit touches them. What an edit destroys is the PRESCRIPTION, and the
// whole feature is one guarantee: taking a snapshot must not disturb the live
// plan that clients are running.
//
// So these tests are mostly about what must NOT move. The snapshot is a copy;
// the live plan keeps its id, its assignments and its clients. If a future
// refactor makes "save a version" repoint assignments to a new plan, every
// client on a shared template migrates at once — silently, and mid-block.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => {
  const query = jest.fn();
  return { query, connect: jest.fn(async () => ({ query, release: () => {} })) };
});

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (req, res, next) =>
    (['admin', 'manager', 'trainer'].includes(req.user?.role)
      ? next()
      : res.status(403).json({ error: 'Admin, manager or trainer access required' })),
}));
jest.mock('../lib/screeningGate', () => ({
  checkScreeningGate: jest.fn(async () => ({ blocked: null, warnings: [] })),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use('/api/workouts', require('../routes/workouts'));

const ORG_A = '11111111-1111-1111-1111-111111111111';
const PLAN = 'plan-1';
const ADMIN_A = { id: 'u-admin', role: 'admin', organization_id: ORG_A, trainer_id: null };
const MEMBER_A = { id: 'u-mem', role: 'member', organization_id: ORG_A, trainer_id: null };

const sqls = () => pool.query.mock.calls.map(([s]) => String(s).replace(/\s+/g, ' '));
const find = (re) => sqls().find((s) => re.test(s));
const paramsOf = (re) => {
  const call = pool.query.mock.calls.find(([s]) => re.test(String(s).replace(/\s+/g, ' ')));
  return call ? call[1] : null;
};

/** A live plan: no parent, so it is snapshot-able. */
const LIVE = { id: PLAN, organization_id: ORG_A, version: 3, parent_plan_id: null };

/**
 * The version bump returns a DIFFERENT row from the load.
 *
 * A blanket `mockResolvedValue({ rows: [LIVE] })` makes every query answer 3,
 * which makes "the snapshot keeps the old number" unfalsifiable — reporting
 * the post-bump version would pass it. Routing on the SQL is what gives the
 * two numbers something to disagree about.
 */
const routed = (loaded = LIVE) => async (sql) => (
  /UPDATE workout_plans SET version = version \+ 1/.test(String(sql))
    ? { rows: [{ ...loaded, version: loaded.version + 1 }], rowCount: 1 }
    : { rows: [loaded], rowCount: 1 }
);

beforeEach(() => {
  mockUser = ADMIN_A;
  pool.query.mockReset();
  pool.query.mockImplementation(routed());
});

describe('POST /plans/:id/versions', () => {
  it('copies the plan instead of moving it — the live id never changes', async () => {
    const res = await request(app).post(`/api/workouts/plans/${PLAN}/versions`).expect(201);

    // The insert names a NEW id and points parent_plan_id at the live one.
    const insert = find(/INSERT INTO workout_plans/);
    expect(insert).toBeDefined();
    expect(insert).toMatch(/parent_plan_id/);

    // And nothing repoints an assignment. This is the guarantee: clients keep
    // running the plan they were assigned, under the same id.
    expect(find(/UPDATE workout_assignments/)).toBeUndefined();
    expect(res.body.snapshot.id).not.toBe(PLAN);
  });

  it('archives the copy so it can never be listed or assigned', async () => {
    await request(app).post(`/api/workouts/plans/${PLAN}/versions`).expect(201);
    const insert = find(/INSERT INTO workout_plans/);
    // is_template and is_active both false: the plan list filters on
    // is_active, so a snapshot that arrived active would show up as a real
    // programme a trainer could assign to a client.
    expect(insert).toMatch(/SELECT \$1, name.*false, false, \$2/);
  });

  it('copies the exercises in the same transaction as the plan', async () => {
    await request(app).post(`/api/workouts/plans/${PLAN}/versions`).expect(201);
    const copy = find(/INSERT INTO workout_exercises .* SELECT gen_random_uuid/);
    expect(copy).toBeDefined();
    // week_number travels with the row: a hand-written deload week is part of
    // what the programme said, and a snapshot missing it is not a snapshot.
    expect(copy).toMatch(/week_number/);
    expect(sqls()).toContain('BEGIN');
    expect(sqls()).toContain('COMMIT');
  });

  it('moves the LIVE plan forward and leaves the snapshot on the old number', async () => {
    const res = await request(app).post(`/api/workouts/plans/${PLAN}/versions`).expect(201);
    expect(find(/UPDATE workout_plans SET version = version \+ 1/)).toBeDefined();
    // The snapshot IS version 3 — the state that was frozen. The live plan
    // becomes 4. Naming the snapshot 4 would mean the history and the plan
    // both claim the same number.
    expect(res.body.snapshot.version).toBe(3);
  });

  it('refuses to snapshot a snapshot', async () => {
    // A chain of parents is a shape nothing renders and nobody asked for.
    pool.query.mockImplementation(routed({ ...LIVE, parent_plan_id: 'plan-0' }));
    const res = await request(app).post(`/api/workouts/plans/${PLAN}/versions`).expect(400);
    expect(res.body.error).toMatch(/already an archived version/i);
    expect(find(/INSERT INTO workout_plans/)).toBeUndefined();
    expect(sqls()).toContain('ROLLBACK');
  });

  it('404s on another studio\'s plan rather than copying it', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await request(app).post(`/api/workouts/plans/${PLAN}/versions`).expect(404);
    expect(find(/INSERT INTO workout_plans/)).toBeUndefined();
  });

  it('keeps members out', async () => {
    mockUser = MEMBER_A;
    await request(app).post(`/api/workouts/plans/${PLAN}/versions`).expect(403);
  });
});

describe('GET /plans/:id/versions', () => {
  it('scopes the history through the parent plan', async () => {
    await request(app).get(`/api/workouts/plans/${PLAN}/versions`).expect(200);
    const guard = find(/SELECT wp\.id FROM workout_plans wp WHERE wp\.id = \$1/);
    expect(guard).toMatch(/wp\.organization_id = \$\d/);
    expect(paramsOf(/SELECT wp\.id FROM workout_plans wp WHERE wp\.id = \$1/)).toContain(ORG_A);
  });

  it('404s without reading any history when the plan is not visible', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await request(app).get(`/api/workouts/plans/${PLAN}/versions`).expect(404);
    expect(find(/WHERE wp\.parent_plan_id/)).toBeUndefined();
  });

  it('returns newest first', async () => {
    await request(app).get(`/api/workouts/plans/${PLAN}/versions`).expect(200);
    expect(find(/WHERE wp\.parent_plan_id = \$1/)).toMatch(/ORDER BY wp\.version DESC/);
  });
});
