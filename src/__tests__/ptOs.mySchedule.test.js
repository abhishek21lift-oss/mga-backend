// GET /api/pt-os/sessions/my — resolving "who am I as a trainer".
//
// The page this backs (My Schedule) showed a studio owner the card
// "Your account isn't linked to a trainer profile — ask an admin to link your
// login", while that owner WAS the admin and had a diary full of sessions.
//
// Two independent reasons the old single-id lookup was wrong, one test group
// each:
//
//   1. `users.trainer_id` is only populated by the studio-approval path. Any
//      other account — including every studio predating that flow — has it
//      null, so the route short-circuited before looking at anything else.
//
//   2. `pt_sessions.trainer_id` has had no foreign key since migration 018
//      dropped pt_sessions_trainer_id_fkey, and the Book Session picker is a
//      UNION of `trainers` and `pt_trainers`. One human is routinely a row in
//      both, so their sessions carry two different trainer_ids.
//
// Asserted on the emitted SQL and its bound parameters, not only on returned
// rows: a mock can be coaxed into returning the right thing by accident, but
// the query either carries the org filter and the full id set or it does not.
'use strict';

const queries = [];
let mockTrainerRows = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: flat, params });
    // The identity lookup — the UNION over the two trainer tables.
    if (/FROM trainers/i.test(flat) && /LOWER\(email\)/i.test(flat)) {
      return { rows: mockTrainerRows, rowCount: mockTrainerRows.length };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORG_A = '11111111-1111-1111-1111-111111111111';

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
  return a;
}

/** The identity lookup over the two trainer tables. */
const identityQuery = () =>
  queries.find((q) => /LOWER\(email\)/i.test(q.sql) && /UNION/i.test(q.sql));

/** The schedule query itself. */
const scheduleQuery = () =>
  queries.find((q) => /FROM pt_sessions/i.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  mockTrainerRows = [];
  mockUser = {
    id: 'u1', role: 'admin', email: 'owner@studio.com',
    trainer_id: null, organization_id: ORG_A,
  };
});

describe('resolving the caller trainer profile', () => {
  test('an unlinked owner is found by email, in both trainer tables', async () => {
    // The reported bug: trainer_id null, but a trainers row exists.
    mockTrainerRows = [{ id: 'tr-1' }];

    const res = await request(app()).get('/api/pt-os/sessions/my');

    expect(res.status).toBe(200);
    expect(res.body.trainer_linked).toBe(true);
    const q = identityQuery();
    expect(q).toBeTruthy();
    // Both halves of the UNION, or the pt_trainers sessions stay invisible.
    expect(q.sql).toMatch(/FROM trainers/i);
    expect(q.sql).toMatch(/FROM pt_trainers/i);
    expect(q.params[0]).toBe('owner@studio.com');
  });

  test('matches on both id spaces at once, not just the linked one', async () => {
    // The same person as a `trainers` row AND a `pt_trainers` row. Sessions
    // booked before and after 018 carry different ids for one human.
    mockUser.trainer_id = 'tr-linked';
    mockTrainerRows = [{ id: 'tr-linked' }, { id: 'ptr-2' }];

    await request(app()).get('/api/pt-os/sessions/my');

    const q = scheduleQuery();
    expect(q.sql).toMatch(/s\.trainer_id = ANY\(\$1\)/);
    // De-duplicated: tr-linked arrives from both the column and the lookup.
    expect(q.params[0]).toEqual(['tr-linked', 'ptr-2']);
  });

  test('email is matched case-insensitively', async () => {
    mockUser.email = '  Owner@Studio.COM  ';
    mockTrainerRows = [{ id: 'tr-1' }];

    await request(app()).get('/api/pt-os/sessions/my');

    // Lower-cased and trimmed on the way in, LOWER() on the column — a stored
    // 'owner@studio.com' and a typed 'Owner@Studio.COM' are the same person.
    expect(identityQuery().params[0]).toBe('owner@studio.com');
    expect(identityQuery().sql).toMatch(/LOWER\(email\) = \$1/);
  });

  test('a genuinely unlinked account still reports trainer_linked false', async () => {
    // A front-desk admin who does not train. Not an error — the page needs to
    // be able to say why rather than show a blank agenda.
    mockTrainerRows = [];

    const res = await request(app()).get('/api/pt-os/sessions/my');

    expect(res.body).toEqual({ data: [], total: 0, trainer_linked: false });
    // And it must not have gone on to query sessions with an empty id list,
    // which `= ANY('{}')` would make an expensive way to select nothing.
    expect(scheduleQuery()).toBeUndefined();
  });

  test('an account with no email at all does not query for one', async () => {
    mockUser.email = null;

    const res = await request(app()).get('/api/pt-os/sessions/my');

    expect(res.body.trainer_linked).toBe(false);
    expect(identityQuery()).toBeUndefined();
  });
});

describe('tenant isolation of the identity lookup', () => {
  test('the email match is scoped to the caller organization', async () => {
    mockTrainerRows = [{ id: 'tr-1' }];

    await request(app()).get('/api/pt-os/sessions/my');

    const q = identityQuery();
    // Once per half of the UNION. Filtering one half still lets a same-email
    // trainer at another studio resolve as "me".
    expect(q.sql.match(/organization_id = \$2/g)).toHaveLength(2);
    expect(q.params).toEqual(['owner@studio.com', ORG_A]);
  });

  test('the schedule query is org-scoped independently of the id set', async () => {
    // The boundary that actually holds: even if a trainer id resolved wrongly,
    // sessions are still constrained to the caller's organisation.
    mockTrainerRows = [{ id: 'tr-1' }];

    await request(app()).get('/api/pt-os/sessions/my');

    const q = scheduleQuery();
    expect(q.sql).toMatch(/s\.organization_id = \$2/);
    expect(q.params[1]).toBe(ORG_A);
  });
});

describe('the date window the page asks for', () => {
  test('from/to are passed through and numbered after the id set', async () => {
    mockTrainerRows = [{ id: 'tr-1' }];

    await request(app())
      .get('/api/pt-os/sessions/my?from=2026-08-10&to=2026-08-16');

    const q = scheduleQuery();
    expect(q.sql).toMatch(/s\.session_date >= \$3/);
    expect(q.sql).toMatch(/s\.session_date <= \$4/);
    expect(q.params).toEqual([['tr-1'], ORG_A, '2026-08-10', '2026-08-16']);
  });

  test('sessions come back in chronological order for a day agenda', async () => {
    mockTrainerRows = [{ id: 'tr-1' }];

    await request(app()).get('/api/pt-os/sessions/my');

    // The page groups by day and renders the list as-is, so an unordered
    // result shows a 6pm session above a 7am one.
    expect(scheduleQuery().sql).toMatch(/ORDER BY s\.session_date ASC, s\.start_time ASC/);
  });

  test('client name and mobile ride along for the agenda row', async () => {
    mockTrainerRows = [{ id: 'tr-1' }];

    await request(app()).get('/api/pt-os/sessions/my');

    const q = scheduleQuery();
    expect(q.sql).toMatch(/c\.name AS client_name/);
    expect(q.sql).toMatch(/c\.mobile AS client_mobile/);
  });
});
