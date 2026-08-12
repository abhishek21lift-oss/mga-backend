// PUT /api/clients/:id — must write pt_clients, scope by org, and not blank
// out the fields it was not asked to change.
//
// Three separate faults met in this one handler:
//
//  1. It read and wrote the legacy `clients` table while GET / and GET /:id had
//     already moved to pt_clients. `clients` has been empty since the PT-OS
//     enrolment flow shipped, so the first SELECT found nothing and every
//     request 404'd — including for the client the page had just rendered.
//     Symptom: Save Notes on the client profile always failed.
//
//  2. It had no organization filter. Harmless against an empty table; against
//     pt_clients, which holds every studio's clients, `WHERE id=$1` is a
//     cross-tenant write. Fixing (1) without (2) would have been worse than
//     the bug.
//
//  3. It is a full-row UPDATE fed by a partial body, and wrote `d.x || null`
//     for most columns. The client profile sends only { notes }, so a note save
//     would have blanked mobile, email, dob, address, PT dates and weight. Also
//     invisible only because of (1).
//
// The preservation tests below are the ones that matter most: (1) and (2) fail
// loudly, (3) would have quietly destroyed customer data.
'use strict';

const CLIENT_ID = 'ptc-1';
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const EXISTING = {
  id: CLIENT_ID, organization_id: ORG_A,
  name: 'Ravi Kumar', mobile: '9876543210', email: 'ravi@example.com',
  gender: 'male', dob: '1990-05-04', address: '12 MG Road',
  trainer_id: null, trainer_name: null,
  pt_start_date: '2026-01-01', pt_end_date: '2026-12-31',
  package_type: 'Quarterly', base_amount: 10000, discount: 0,
  final_amount: 10000, paid_amount: 4000, balance_amount: 6000,
  weight: 72.5, notes: 'old note', status: 'active',
  photo_url: 'https://cdn/x.jpg', biometric_code: 'BIO-1', client_id: 'C-1',
};

let mockRows = [EXISTING];
const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/^SELECT \* FROM pt_clients/i.test(text)) return { rows: mockRows, rowCount: mockRows.length };
    if (/FROM trainers/i.test(text)) return { rows: [{ name: 'Coach' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));

let mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
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
  a.use((req, _res, next) => { req.branchScope = { appendTo: (p) => ({ sql: 'TRUE', params: p || [] }) }; next(); });
  a.use('/api/clients', require('../routes/clients'));
  return a;
}

const updateQuery = () => mockQueries.find((q) => /^UPDATE pt_clients SET/i.test(q.sql));
/** Value bound to a named column in the UPDATE, resolved through its $N slot. */
function bound(col) {
  const q = updateQuery();
  const m = new RegExp(`${col}=\\$(\\d+)`).exec(q.sql);
  return m ? q.params[Number(m[1]) - 1] : undefined;
}

beforeEach(() => {
  mockQueries.length = 0;
  mockRows = [EXISTING];
  mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
});

describe('PUT /clients/:id', () => {
  test('writes pt_clients, never the dead clients table', async () => {
    const res = await request(app()).put(`/api/clients/${CLIENT_ID}`).send({ notes: 'new note' });

    expect(res.status).toBe(200);
    expect(updateQuery()).toBeTruthy();
    // Any statement touching bare `clients` means the old target is back.
    for (const q of mockQueries) expect(q.sql).not.toMatch(/\b(FROM|UPDATE|INTO) clients\b/i);
  });

  test('a note save does not blank the fields it never sent', async () => {
    // The exact call the client profile makes.
    await request(app()).put(`/api/clients/${CLIENT_ID}`).send({ notes: 'new note' });

    expect(bound('notes')).toBe('new note');
    expect(bound('mobile')).toBe('9876543210');
    expect(bound('email')).toBe('ravi@example.com');
    expect(bound('dob')).toBe('1990-05-04');
    expect(bound('address')).toBe('12 MG Road');
    expect(bound('gender')).toBe('male');
    expect(bound('pt_start_date')).toBe('2026-01-01');
    expect(bound('pt_end_date')).toBe('2026-12-31');
    expect(bound('weight')).toBe(72.5);
    expect(bound('photo_url')).toBe('https://cdn/x.jpg');
    expect(bound('status')).toBe('active');
  });

  test('an explicit empty string still clears a field', async () => {
    // `??` not `||` — otherwise clearing a note would silently restore the old
    // one, which reads as the save being ignored.
    await request(app()).put(`/api/clients/${CLIENT_ID}`).send({ notes: '' });

    expect(bound('notes')).toBe('');
  });

  test('supplied fields are applied', async () => {
    await request(app()).put(`/api/clients/${CLIENT_ID}`).send({ name: '  Ravi K  ', mobile: '9000000000' });

    expect(bound('name')).toBe('Ravi K');
    expect(bound('mobile')).toBe('9000000000');
  });

  test('scopes the lookup to the caller organization', async () => {
    await request(app()).put(`/api/clients/${CLIENT_ID}`).send({ notes: 'x' });

    const find = mockQueries.find((q) => /^SELECT \* FROM pt_clients/i.test(q.sql));
    expect(find.sql).toMatch(/organization_id = \$2/);
    expect(find.params).toEqual([CLIENT_ID, ORG_A]);
  });

  test('another studio cannot edit this client — it 404s, and writes nothing', async () => {
    // The scope clause is what makes the row invisible; the mock returns rows
    // regardless, so assert on the params the query was scoped with AND that
    // no UPDATE ran once the row is treated as missing.
    mockUser = { id: 'u2', role: 'admin', organization_id: ORG_B };
    mockRows = [];
    const res = await request(app()).put(`/api/clients/${CLIENT_ID}`).send({ notes: 'hijack' });

    expect(res.status).toBe(404);
    expect(updateQuery()).toBeUndefined();
  });

  test('a platform super admin is not org-filtered', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    await request(app()).put(`/api/clients/${CLIENT_ID}`).send({ notes: 'x' });

    const find = mockQueries.find((q) => /^SELECT \* FROM pt_clients/i.test(q.sql));
    expect(find.sql).not.toMatch(/organization_id/);
    expect(find.params).toEqual([CLIENT_ID]);
  });

  test('gym-only columns are gone — pt_clients has no such fields', async () => {
    await request(app()).put(`/api/clients/${CLIENT_ID}`).send({ notes: 'x' });

    const sql = updateQuery().sql;
    for (const col of ['payment_method', 'payment_date', 'biometric_added', 'member_code']) {
      expect(sql).not.toMatch(new RegExp(`\\b${col}=`));
    }
  });
});
