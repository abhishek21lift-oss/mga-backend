// DELETE /api/settings/branches/:id
//
// ── History, because this file's assertions were rewritten and the reason
//    matters more than the assertions ─────────────────────────────────────────
//
// Originally: the Settings → Branches screen rendered a Delete button wired to
// api.branches.delete(), but settings.js registered only GET/POST/PUT. The call
// 404'd, the catch showed "Failed to delete branch", and the row stayed. This
// file was written with the handler that fixed that.
//
// Its interesting case was a refusal. Branches lived in `system_settings` under
// a `branch_<uuid>` key, `clients.branch_id` stored that full key, and there was
// no foreign key — so nothing cascaded and nothing was nulled. A hard delete of
// a populated branch left rows pointing at a key that no longer resolved, and
// they dropped out of every per-branch view without a word. Hence 409 rather
// than delete.
//
// Two things have since changed, and together they retire that guard rather
// than merely remove it:
//
//  1. Migration 167 moved branches out of the global key/value table into the
//     real `branches` table with an organization_id. That was V-06 in
//     TENANT_SECURITY_AUDIT.md: every studio could see, edit and DELETE every
//     other studio's branches. The old tests here asserted addressing by the
//     bare settings key, which no longer exists as an addressing scheme.
//
//  2. The delete is now SOFT. A soft-deleted branch row still exists and still
//     resolves — `branches.code` preserves the original `branch_<uuid>` key
//     precisely so `users.branch_id` and any historical `clients.branch_id`
//     keep resolving. So the dangling-reference failure the 409 existed to
//     prevent cannot happen, which is a better answer than refusing the delete.
//
// The member-count refusal is therefore gone, and this is the honest reason it
// is not simply reinstated: it counted `FROM clients WHERE branch_id = …`, and
// `clients` is the legacy table with 0 rows that clients.legacy-table.test.js
// now fails the build over. The count was structurally always zero, so the 409
// could never fire in production — the old test proved the code path worked
// against a mocked count, not that anything was ever protected. Neither
// `members` nor `pt_clients` records a branch yet; when the member domain gains
// branch assignment, the check comes back against `members` and belongs in this
// file again.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const BRANCH_ID = '0b4d1f2e-1111-2222-3333-444455556666';

let mockBranchRows;

const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/branches/i.test(text)) {
      return { rows: mockBranchRows, rowCount: mockBranchRows.length };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (req, res, next) => (
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' })
  ),
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
  a.use('/api/settings', require('../routes/settings'));
  return a;
}

const softDelete = () => mockQueries.find((q) => /UPDATE branches SET deleted_at/i.test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  mockBranchRows = [{ id: BRANCH_ID }];
  mockUser = { id: 'admin-1', role: 'admin', organization_id: ORG_A };
});

describe('DELETE /settings/branches/:id', () => {
  test('deletes a branch and reports it', async () => {
    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(res.status).toBe(200);
    // The client types this as { message: string } and shows it on success.
    expect(res.body).toEqual({ message: 'Branch deleted' });
    expect(softDelete()).toBeDefined();
  });

  test('is a soft delete, so nothing referencing the branch is left dangling', async () => {
    // This is what replaced the member-count 409. See the note at the top.
    await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(softDelete().sql).toMatch(/SET deleted_at = NOW\(\)/i);
    expect(mockQueries.some((q) => /DELETE FROM branches/i.test(q.sql))).toBe(false);
  });

  test('addresses the row by its own id, scoped to the caller organization', async () => {
    await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    const q = softDelete();
    expect(q.sql).toMatch(/WHERE id = \$1 AND organization_id = \$2/);
    expect(q.params).toEqual([BRANCH_ID, ORG_A]);
  });

  test("does not delete another studio's branch", async () => {
    // The defect this replaced: with branches in a global table and no
    // predicate, this call removed a branch belonging to a different studio.
    mockUser = { id: 'admin-2', role: 'admin', organization_id: ORG_B };
    mockBranchRows = []; // the organization predicate matched nothing

    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(res.status).toBe(404);
    expect(softDelete().params).toEqual([BRANCH_ID, ORG_B]);
  });

  test('no longer touches the global system_settings table', async () => {
    await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);
    expect(mockQueries.some((q) => /system_settings/i.test(q.sql))).toBe(false);
  });

  test('404s an unknown branch instead of reporting a successful delete', async () => {
    mockBranchRows = [];
    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('refuses a caller with no studio rather than deleting globally', async () => {
    mockUser = { id: 'sa-1', role: 'admin', organization_id: null };
    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ORG_REQUIRED');
    expect(softDelete()).toBeUndefined();
  });

  test('a non-admin cannot delete a branch', async () => {
    mockUser = { id: 'r-1', role: 'reception', organization_id: ORG_A };
    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(res.status).toBe(403);
    expect(softDelete()).toBeUndefined();
  });
});
