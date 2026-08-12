// GET /api/pt-os/parq/forms/:id — the clearance/consent response contract.
//
// This route used to return `medical_clearances` and `consent_records`, the raw
// row arrays. The client's ParqFormDetail contract declares `medical_clearance`
// and `consent`, singular, and nothing on the client ever referenced the plural
// names — so both fields arrived undefined. Two things broke silently:
//
//   1. The PAR-Q edit screen hydrates from these fields. A form WITH a clearance
//      and a signed consent rendered both sections blank.
//   2. The screen reads `row.medical_clearance?.id` into `clearanceId`, which is
//      what picks PATCH-vs-POST on save. Undefined meant every re-save took the
//      create path and wrote a duplicate pt_medical_clearances row. Likewise
//      `row.consent` gates consent creation, so re-saving re-signed the consent
//      and regenerated its PDF.
//
// Asserted on the response keys rather than only on the values, because the bug
// was never a wrong value — it was a right value under a name nobody read. The
// absence assertions are the ones that matter: if the plural keys come back,
// that is the old shape returning.
'use strict';

const FORM_ID = 'parq-form-1';
const ORG_A = '11111111-1111-1111-1111-111111111111';

const NEWER_CLEARANCE = { id: 'mc-new', parq_form_id: FORM_ID, doctor_name: 'Dr Newer' };
const OLDER_CLEARANCE = { id: 'mc-old', parq_form_id: FORM_ID, doctor_name: 'Dr Older' };
const NEWER_CONSENT = { id: 'cr-new', parq_form_id: FORM_ID, client_signature: 'newer' };
const OLDER_CONSENT = { id: 'cr-old', parq_form_id: FORM_ID, client_signature: 'older' };

// Each test sets what the two child queries return; the rest stay empty.
let mockClearanceRows = [];
let mockConsentRows = [];
let mockFormRows = [{ id: FORM_ID, client_id: 'c1', risk_level: 'high', organization_id: ORG_A }];

const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/FROM pt_parq_forms/i.test(text)) return { rows: mockFormRows, rowCount: mockFormRows.length };
    if (/FROM pt_medical_clearances/i.test(text)) return { rows: mockClearanceRows, rowCount: mockClearanceRows.length };
    if (/FROM pt_consent_records/i.test(text)) return { rows: mockConsentRows, rowCount: mockConsentRows.length };
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));
jest.mock('../lib/parqPdf', () => ({ generateConsentPdf: jest.fn() }));
jest.mock('../lib/fileStorage', () => ({ saveFile: jest.fn() }));

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
jest.mock('../middleware/rbac', () => ({ requireRole: () => (_req, _res, next) => next() }));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/parq.routes'));
  return a;
}

beforeEach(() => {
  mockQueries.length = 0;
  mockClearanceRows = [];
  mockConsentRows = [];
  mockFormRows = [{ id: FORM_ID, client_id: 'c1', risk_level: 'high', organization_id: ORG_A }];
  mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
});

describe('GET /pt-os/parq/forms/:id clearance + consent shape', () => {
  test('returns the clearance singular, under the name the client reads', async () => {
    mockClearanceRows = [NEWER_CLEARANCE];
    const res = await request(app()).get(`/api/pt-os/parq/forms/${FORM_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data.medical_clearance).toEqual(NEWER_CLEARANCE);
    // The old plural key is what left the edit screen blank. It must not return.
    expect(res.body.data).not.toHaveProperty('medical_clearances');
  });

  test('returns the consent singular, under the name the client reads', async () => {
    mockConsentRows = [NEWER_CONSENT];
    const res = await request(app()).get(`/api/pt-os/parq/forms/${FORM_ID}`);

    expect(res.body.data.consent).toEqual(NEWER_CONSENT);
    expect(res.body.data).not.toHaveProperty('consent_records');
  });

  test('a form with no clearance or consent yields null, not undefined', async () => {
    // The client does `if (row.medical_clearance?.id)`, so null is safe — but an
    // absent key and a null one are different over the wire, and the contract
    // declares `MedicalClearance | null`.
    const res = await request(app()).get(`/api/pt-os/parq/forms/${FORM_ID}`);

    expect(res.body.data).toHaveProperty('medical_clearance', null);
    expect(res.body.data).toHaveProperty('consent', null);
  });

  test('picks the current record when a form has history behind it', async () => {
    // Forms that were re-saved under the old behaviour already carry duplicate
    // clearance rows. Both queries order by created_at DESC, so the newest is
    // row 0 — picking any other would resurrect a superseded doctor sign-off.
    mockClearanceRows = [NEWER_CLEARANCE, OLDER_CLEARANCE];
    mockConsentRows = [NEWER_CONSENT, OLDER_CONSENT];
    const res = await request(app()).get(`/api/pt-os/parq/forms/${FORM_ID}`);

    expect(res.body.data.medical_clearance).toEqual(NEWER_CLEARANCE);
    expect(res.body.data.consent).toEqual(NEWER_CONSENT);
  });

  test('child queries still order newest-first, which is what makes row 0 current', async () => {
    // Asserted on the SQL because the "newest wins" test above would also pass
    // on an unordered query that happened to come back in insertion order.
    await request(app()).get(`/api/pt-os/parq/forms/${FORM_ID}`);

    const clearanceQ = mockQueries.find((q) => /FROM pt_medical_clearances/i.test(q.sql));
    const consentQ = mockQueries.find((q) => /FROM pt_consent_records/i.test(q.sql));
    expect(clearanceQ.sql).toMatch(/ORDER BY created_at DESC/i);
    expect(consentQ.sql).toMatch(/ORDER BY created_at DESC/i);
  });

  test('the collection fields stay arrays — only clearance and consent collapsed', async () => {
    const res = await request(app()).get(`/api/pt-os/parq/forms/${FORM_ID}`);

    expect(Array.isArray(res.body.data.family_history)).toBe(true);
    expect(Array.isArray(res.body.data.documents)).toBe(true);
  });

  test('a missing form still 404s rather than returning a null-filled shell', async () => {
    mockFormRows = [];
    const res = await request(app()).get(`/api/pt-os/parq/forms/${FORM_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.data).toBeUndefined();
  });
});
