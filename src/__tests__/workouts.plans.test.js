// Workout plan endpoints: tenant isolation, trainer access, and the guarantees
// the builder's autosave depends on.
//
// Three of these are regression tests for defects found while redesigning the
// module. Each one was real on the branch this replaces:
//
//   1. NONE of the five plan endpoints filtered by organization, while the
//      assignment endpoints in the same file did. Any authenticated user could
//      read, edit or delete another studio's plan by id.
//   2. Plan writes sat behind adminOrManager, so trainers — the people the
//      module exists for — got a 403 on every save.
//   3. `parseInt(x) || fallback` turned `sets: 0` into 3 and `rest_seconds: 0`
//      into 60, so a trainer could not prescribe a superset with no rest and
//      the value saved was not the value typed.
//
// The fourth group covers the new granular endpoints, whose entire reason for
// existing is that a Monday edit must not touch Tuesday.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => {
  const query = jest.fn();
  return { query, connect: jest.fn(async () => ({ query, release: () => {} })) };
});

// The caller's identity is swapped per-test via mockUser. The `mock` prefix is
// required: jest hoists mock factories above declarations and only allows
// out-of-scope references whose name begins with "mock".
let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOrManager: (req, res, next) =>
    (['admin', 'manager'].includes(req.user?.role)
      ? next()
      : res.status(403).json({ error: 'Admin or manager access required' })),
  // The real implementation, inlined — this suite exists partly to prove
  // trainers get through it.
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

const ADMIN_A   = { id: 'u-admin', role: 'admin',   organization_id: ORG_A, trainer_id: null };
const TRAINER_A = { id: 'u-tr',    role: 'trainer', organization_id: ORG_A, trainer_id: 'tr-1' };
const MEMBER_A  = { id: 'u-mem',   role: 'member',  organization_id: ORG_A, trainer_id: null };

/** Every SQL string the request issued, whitespace-collapsed. */
const sqls = () => pool.query.mock.calls.map(([s]) => String(s).replace(/\s+/g, ' '));
/** Params of the first call whose SQL matches. */
const paramsOf = (re) => {
  const call = pool.query.mock.calls.find(([s]) => re.test(String(s).replace(/\s+/g, ' ')));
  return call ? call[1] : null;
};

beforeEach(() => {
  mockUser = ADMIN_A;
  pool.query.mockReset();
  // Default: every query resolves to one innocuous row. Individual tests
  // override with mockResolvedValueOnce where the shape matters.
  pool.query.mockResolvedValue({ rows: [{ id: PLAN, organization_id: ORG_A }] });
});

describe('tenant isolation — plans are scoped to the caller\'s studio', () => {
  it('filters the plan list by organization', async () => {
    await request(app).get('/api/workouts/plans');
    const select = sqls().find((s) => /FROM workout_plans wp/.test(s));
    expect(select).toMatch(/wp\.organization_id = \$/);
  });

  it('scopes plan detail, and lets shared platform templates through', async () => {
    await request(app).get(`/api/workouts/plans/${PLAN}`);
    const select = sqls().find((s) => /SELECT wp\.\* FROM workout_plans/.test(s));
    // Both halves matter: the org match is the isolation, and the IS NULL is
    // what keeps the shared template library visible to every studio.
    expect(select).toMatch(/wp\.organization_id = \$\d/);
    expect(select).toMatch(/wp\.organization_id IS NULL/);
  });

  it('refuses to update a plan belonging to another studio', async () => {
    // loadEditablePlan finds nothing because the org does not match.
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .put(`/api/workouts/plans/${PLAN}`)
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
    // Nothing was written.
    expect(sqls().some((s) => /UPDATE workout_plans SET/.test(s))).toBe(false);
  });

  it('refuses to delete a plan belonging to another studio', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app).delete(`/api/workouts/plans/${PLAN}`);
    expect(res.status).toBe(404);
    expect(sqls().some((s) => /SET deleted_at=NOW\(\)/.test(s))).toBe(false);
  });

  it('answers 404 rather than 403 for another studio\'s plan', async () => {
    // A 403 would confirm the id exists, which is the fact the tenant
    // boundary is there to hide.
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app).delete(`/api/workouts/plans/${PLAN}`);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it('does NOT let a studio edit a shared platform template', async () => {
    // Readable (IS NULL passes the read filter) but not writable: the edit
    // path requires an exact org match, so the SQL must not admit NULL.
    await request(app).put(`/api/workouts/plans/${PLAN}`).send({ name: 'x' });
    const load = sqls().find((s) => /SELECT wp\.\* FROM workout_plans wp WHERE wp\.id/.test(s));
    expect(load).toMatch(/wp\.organization_id = \$\d/);
    expect(load).not.toMatch(/organization_id IS NULL/);
  });
});

describe('trainer access — the module is usable by the people it is for', () => {
  it('lets a trainer create a plan', async () => {
    mockUser = TRAINER_A;
    const res = await request(app).post('/api/workouts/plans').send({ name: 'Push Day' });
    expect(res.status).toBe(201);
  });

  it('lets a trainer edit a plan they own', async () => {
    mockUser = TRAINER_A;
    const res = await request(app).put(`/api/workouts/plans/${PLAN}`).send({ name: 'Push Day v2' });
    expect(res.status).toBe(200);
  });

  it('restricts a trainer to plans they created or that are assigned to their clients', async () => {
    mockUser = TRAINER_A;
    await request(app).put(`/api/workouts/plans/${PLAN}`).send({ name: 'x' });
    const load = sqls().find((s) => /SELECT wp\.\* FROM workout_plans wp WHERE wp\.id/.test(s));
    expect(load).toMatch(/wp\.created_by = \$/);
    expect(load).toMatch(/pc\.trainer_id = \$/);
    // Scoped by the trainer's own id, not a value from the request.
    expect(paramsOf(/SELECT wp\.\* FROM workout_plans wp WHERE wp\.id/)).toContain('tr-1');
  });

  it('does NOT apply the ownership clause for an admin', async () => {
    mockUser = ADMIN_A;
    await request(app).put(`/api/workouts/plans/${PLAN}`).send({ name: 'x' });
    const load = sqls().find((s) => /SELECT wp\.\* FROM workout_plans wp WHERE wp\.id/.test(s));
    expect(load).not.toMatch(/pc\.trainer_id/);
  });

  it('still refuses a member', async () => {
    mockUser = MEMBER_A;
    const res = await request(app).post('/api/workouts/plans').send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('lets a trainer assign a plan only to their own client', async () => {
    mockUser = TRAINER_A;
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: PLAN }] })  // plan is visible
      .mockResolvedValueOnce({ rows: [] });             // client is NOT theirs
    const res = await request(app)
      .post('/api/workouts/assign')
      .send({ workout_plan_id: PLAN, client_id: 'someone-elses-client' });
    expect(res.status).toBe(404);
    expect(sqls().some((s) => /INSERT INTO workout_assignments/.test(s))).toBe(false);
  });
});

describe('numeric coercion — a prescribed zero survives', () => {
  it('keeps sets: 0 and rest_seconds: 0 instead of substituting defaults', async () => {
    // `parseInt(0) || 3` is 3. A superset with no rest between movements is a
    // real prescription, and the old handler quietly rewrote it to 60 seconds.
    await request(app).post('/api/workouts/plans').send({
      name: 'Zeroes',
      exercises: [{ exercise_id: 'ex-1', sets: 0, reps: 0, rest_seconds: 0 }],
    });
    const params = paramsOf(/INSERT INTO workout_exercises/);
    expect(params).toContain(0);
    // sets, reps and rest_seconds are all 0 — three of them.
    expect(params.filter((v) => v === 0).length).toBeGreaterThanOrEqual(3);
    expect(params).not.toContain(60);
  });

  it('still falls back when a field is absent', async () => {
    await request(app).post('/api/workouts/plans').send({
      name: 'Defaults', exercises: [{ exercise_id: 'ex-1' }],
    });
    const params = paramsOf(/INSERT INTO workout_exercises/);
    expect(params).toContain(3);   // sets
    expect(params).toContain(12);  // reps
    expect(params).toContain(60);  // rest_seconds
  });

  it('persists the six new parameter columns', async () => {
    await request(app).post('/api/workouts/plans').send({
      name: 'Full', exercises: [{
        exercise_id: 'ex-1', target_weight: 62.5, tempo: '3-1-2-0',
        rpe: 8.5, warmup_sets: 2, superset_group: 'A', config: { amrap: true },
      }],
    });
    const sql = sqls().find((s) => /INSERT INTO workout_exercises/.test(s));
    for (const col of ['target_weight', 'tempo', 'rpe', 'warmup_sets', 'superset_group', 'config']) {
      expect(sql).toContain(col);
    }
    const params = paramsOf(/INSERT INTO workout_exercises/);
    expect(params).toContain(62.5);
    expect(params).toContain('3-1-2-0');
    expect(params).toContain(JSON.stringify({ amrap: true }));
  });
});

describe('granular endpoints — what makes autosave safe', () => {
  it('adding an exercise touches only its own day', async () => {
    // The whole point. The legacy PUT deletes every row for the plan; if the
    // builder autosaved through it, saving Monday would erase Tuesday-Sunday.
    await request(app).post(`/api/workouts/plans/${PLAN}/exercises`)
      .send({ exercise_id: 'ex-1', day_of_week: 1 });
    expect(sqls().some((s) => /DELETE FROM workout_exercises WHERE workout_plan_id = \$1$/.test(s)))
      .toBe(false);
  });

  it('computes the append slot in SQL, so two trainers cannot collide', async () => {
    await request(app).post(`/api/workouts/plans/${PLAN}/exercises`)
      .send({ exercise_id: 'ex-1', day_of_week: 3 });
    const insert = sqls().find((s) => /INSERT INTO workout_exercises/.test(s));
    expect(insert).toMatch(/MAX\(sort_order\) \+ 1/);
  });

  it('patches in place rather than deleting and recreating', async () => {
    // Exercise identity has to survive an edit: it is what drag-reorder and
    // per-card state are keyed on.
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/row-9`)
      .send({ sets: 5 });
    expect(sqls().some((s) => /UPDATE workout_exercises SET/.test(s))).toBe(true);
    expect(sqls().some((s) => /DELETE FROM workout_exercises/.test(s))).toBe(false);
  });

  it('only patches whitelisted columns', async () => {
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/row-9`)
      .send({ sets: 5, id: 'hijack', workout_plan_id: 'other-plan', created_at: 'x' });
    const update = sqls().find((s) => /UPDATE workout_exercises SET/.test(s));
    expect(update).toMatch(/sets = \$/);
    expect(update).not.toMatch(/ id = \$\d.*WHERE/);
    expect(update).not.toMatch(/workout_plan_id = \$\d.*WHERE/);
    expect(update).not.toMatch(/created_at =/);
  });

  it('lets a patch clear a field to null and set a number to zero', async () => {
    await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/row-9`)
      .send({ notes: null, rest_seconds: 0 });
    const update = sqls().find((s) => /UPDATE workout_exercises SET/.test(s));
    expect(update).toMatch(/notes = \$/);
    expect(update).toMatch(/rest_seconds = \$/);
  });

  it('rejects a patch with no editable fields', async () => {
    const res = await request(app).patch(`/api/workouts/plans/${PLAN}/exercises/row-9`).send({});
    expect(res.status).toBe(400);
  });

  it('scopes a delete to the plan in the URL', async () => {
    await request(app).delete(`/api/workouts/plans/${PLAN}/exercises/row-9`);
    const del = sqls().find((s) => /DELETE FROM workout_exercises WHERE id/.test(s));
    // Without the second predicate, a row id from another plan would delete.
    expect(del).toMatch(/workout_plan_id = \$2/);
  });

  it('refuses a reorder that does not name exactly the day\'s exercises', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: PLAN }] })                    // loadEditablePlan
      .mockResolvedValueOnce({ rows: [] })                                // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] });       // day owns a, b
    const res = await request(app).put(`/api/workouts/plans/${PLAN}/days/1/order`)
      .send({ exercise_ids: ['a', 'from-another-day'] });
    expect(res.status).toBe(400);
    expect(sqls().some((s) => /SET sort_order = v\.ord/.test(s))).toBe(false);
  });

  it('reorders in a single statement so no two rows share a slot', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: PLAN }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] })
      .mockResolvedValue({ rows: [] });
    const res = await request(app).put(`/api/workouts/plans/${PLAN}/days/1/order`)
      .send({ exercise_ids: ['b', 'a'] });
    expect(res.status).toBe(200);
    const updates = sqls().filter((s) => /SET sort_order = v\.ord/.test(s));
    expect(updates).toHaveLength(1);
  });

  it('requires an exercise_ids array', async () => {
    const res = await request(app).put(`/api/workouts/plans/${PLAN}/days/1/order`).send({});
    expect(res.status).toBe(400);
  });

  it('checks plan access before every granular write', async () => {
    // Each of the four endpoints must load the plan through loadEditablePlan
    // first; otherwise the tenant and trainer rules apply to the plan-level
    // routes but not to the ones the builder actually calls.
    //
    // ONLY the loadEditablePlan SELECT returns nothing; every other query
    // succeeds. So the sole route to a 404 is the access check — a handler
    // that skips it reaches its real query, gets a row, and answers 2xx.
    //
    // The mock keys on the SQL rather than on call order, and that is
    // load-bearing. Two earlier versions both passed while the check was
    // deleted: mocking everything empty let the handler's own
    // `... RETURNING id` produce the 404 by itself, and mocking only the first
    // call empty just moved the same problem, because with the check gone the
    // handler's own query became the first call. Keying on SQL makes the
    // response depend on WHICH query ran, which is the thing under test.
    const isPlanLoad = (sql) => /SELECT wp\.\* FROM workout_plans wp WHERE wp\.id/
      .test(String(sql).replace(/\s+/g, ' '));

    for (const send of [
      () => request(app).post(`/api/workouts/plans/${PLAN}/exercises`).send({ exercise_id: 'e' }),
      () => request(app).patch(`/api/workouts/plans/${PLAN}/exercises/r`).send({ sets: 1 }),
      () => request(app).delete(`/api/workouts/plans/${PLAN}/exercises/r`),
      () => request(app).put(`/api/workouts/plans/${PLAN}/days/1/order`).send({ exercise_ids: ['a'] }),
    ]) {
      pool.query.mockReset();
      pool.query.mockImplementation(async (sql) =>
        (isPlanLoad(sql) ? { rows: [] } : { rows: [{ id: 'a', sort_order: 0 }] }));
      const res = await send();
      expect(res.status).toBe(404);
    }
  });
});
