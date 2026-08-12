// /api/payments/upi — the authorization and tenant boundary on the LIVE
// payment path.
//
// Audit finding C-4. upi-payments.js is 891 lines and was the largest untested
// route file in the repo. lib/upiPayments.js — the state machine underneath —
// already has unit tests, so what was missing is precisely the layer these
// tests cover: who may call each endpoint, which organization the call is
// executed against, and how a domain error becomes an HTTP status.
//
// This matters more than the Razorpay path it sits next to. Razorpay order
// creation runs only from renewal.worker.js against tables server.js's own
// comments call abandoned, and its webhook writes columns that do not exist —
// so UPI plus manual verification is what actually moves money here.
//
// The single most important assertion in this file is that `orgId` reaching
// upi.approve() comes from the caller's authenticated identity and never from
// anything the caller can set on the request. An approve activates a
// membership and writes a receipt; sourcing its org from a header or body
// would let one studio approve against another's orders.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

class MockPaymentError extends Error {
  constructor(code, message, status, detail) {
    super(message);
    this.code = code; this.status = status; this.detail = detail;
  }
}

const mockUpi = {
  PaymentError: MockPaymentError,
  REJECT_REASONS: { AMOUNT_MISMATCH: 'The amount did not match', OTHER: 'Other' },
  approve: jest.fn(async () => ({
    order: { id: 'ord-1', order_no: 'UPI-1', plan_name: 'Quarterly', total_amount: 9000 },
    submission: { utr: '123456789012' },
    activation: { receipt_no: 'RCPT-9', activated_to: '2026-12-31' },
    member: { id: 'ptc-1' },
  })),
  reject: jest.fn(async () => ({ reason: 'AMOUNT_MISMATCH', note: 'off by 100' })),
  requestCorrection: jest.fn(async () => ({ reason: 'AMOUNT_MISMATCH', note: null })),
};
jest.mock('../lib/upiPayments', () => mockUpi);

jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../lib/fileStorage', () => ({ saveFile: jest.fn(async () => ({ key: 'k', url: 'u' })) }));
jest.mock('../lib/upiReceiptPdf', () => ({ generateUpiReceiptPdf: jest.fn(async () => Buffer.from('pdf')) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock('../db/pool', () => ({
  query: jest.fn(async () => ({ rows: [{ client_id: 'ptc-1', plan_name: 'Quarterly', user_id: 'usr-m' }], rowCount: 1 })),
  connect: jest.fn(),
}));

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (req, res, next) => (
    req.user?.role === 'admin' || req.user?.role === 'super_admin'
      ? next()
      : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/payments/upi', require('../routes/upi-payments'));
  a.use(errorHandler);
  return a;
}

const ORDER = '3f8b1c2d-4e5a-4b7c-9d0e-1a2b3c4d5e6f';

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'usr-admin', role: 'admin', organization_id: ORG_A, trainer_id: null };
});

describe('admin-only endpoints reject non-admins', () => {
  const adminRoutes = [
    ['post', `/api/payments/upi/${ORDER}/approve`, {}],
    ['post', `/api/payments/upi/${ORDER}/reject`, { reason: 'AMOUNT_MISMATCH' }],
    ['get', '/api/payments/upi/pending', null],
  ];

  test.each(adminRoutes)('%s %s is closed to a trainer', async (method, url, body) => {
    mockUser = { id: 'usr-t', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-1' };

    const r = request(app())[method](url);
    const res = await (body ? r.send(body) : r);

    expect(res.status).toBe(403);
    expect(mockUpi.approve).not.toHaveBeenCalled();
    expect(mockUpi.reject).not.toHaveBeenCalled();
  });

  test.each(adminRoutes)('%s %s is closed to a member', async (method, url, body) => {
    mockUser = { id: 'usr-m', role: 'member', organization_id: ORG_A, member_id: 'ptc-1' };

    const r = request(app())[method](url);
    const res = await (body ? r.send(body) : r);

    expect(res.status).toBe(403);
    expect(mockUpi.approve).not.toHaveBeenCalled();
  });
});

describe('the organization an approval executes against', () => {
  test("comes from the caller's identity", async () => {
    const res = await request(app()).post(`/api/payments/upi/${ORDER}/approve`).send({});

    expect(res.status).toBe(200);
    expect(mockUpi.approve).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER, orgId: ORG_A })
    );
  });

  test('is NOT taken from the request body', async () => {
    // An approve activates a membership and writes a receipt. If the org were
    // readable from the body, one studio could approve against another's
    // orders by naming it.
    await request(app())
      .post(`/api/payments/upi/${ORDER}/approve`)
      .send({ organization_id: ORG_B, orgId: ORG_B });

    expect(mockUpi.approve).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A })
    );
  });

  test('ignores an x-org-id header from an ordinary tenant admin', async () => {
    // tenantScope only honours x-org-id for super_admin. A studio owner
    // sending it must stay pinned to their own organization.
    await request(app())
      .post(`/api/payments/upi/${ORDER}/approve`)
      .set('x-org-id', ORG_B)
      .send({});

    expect(mockUpi.approve).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A })
    );
  });

  test('honours x-org-id for a super admin, who is deliberately cross-tenant', async () => {
    mockUser = { id: 'usr-sa', role: 'super_admin', organization_id: null, trainer_id: null };

    await request(app())
      .post(`/api/payments/upi/${ORDER}/approve`)
      .set('x-org-id', ORG_B)
      .send({});

    expect(mockUpi.approve).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_B })
    );
  });

  test('403s an account with no studio context instead of running unscoped', async () => {
    // Fail closed. A null org must not reach upi.approve(), where a missing
    // predicate could match another tenant's order.
    mockUser = { id: 'usr-orphan', role: 'admin', organization_id: null, trainer_id: null };

    const res = await request(app()).post(`/api/payments/upi/${ORDER}/approve`).send({});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_TENANT');
    expect(mockUpi.approve).not.toHaveBeenCalled();
  });

  test('a super admin with no x-org-id is also refused — approval needs a target', async () => {
    mockUser = { id: 'usr-sa', role: 'super_admin', organization_id: null, trainer_id: null };

    const res = await request(app()).post(`/api/payments/upi/${ORDER}/approve`).send({});

    expect(res.status).toBe(403);
    expect(mockUpi.approve).not.toHaveBeenCalled();
  });
});

describe('rejection', () => {
  test('passes the reason and note through to the domain layer', async () => {
    const res = await request(app())
      .post(`/api/payments/upi/${ORDER}/reject`)
      .send({ reason: 'AMOUNT_MISMATCH', note: 'off by 100' });

    expect(res.status).toBe(200);
    expect(mockUpi.reject).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER, orgId: ORG_A, reason: 'AMOUNT_MISMATCH', note: 'off by 100' })
    );
  });

  test('rejects an unknown reason code at the schema, before the domain layer', async () => {
    const res = await request(app())
      .post(`/api/payments/upi/${ORDER}/reject`)
      .send({ reason: 'because-i-said-so' });

    expect(res.status).toBe(400);
    expect(mockUpi.reject).not.toHaveBeenCalled();
  });

  test('requires a reason', async () => {
    const res = await request(app()).post(`/api/payments/upi/${ORDER}/reject`).send({});

    expect(res.status).toBe(400);
    expect(mockUpi.reject).not.toHaveBeenCalled();
  });
});

describe('domain errors become HTTP responses', () => {
  test('a PaymentError keeps its status and code', async () => {
    mockUpi.approve.mockRejectedValueOnce(
      new MockPaymentError('ALREADY_APPROVED', 'This order was already approved', 409)
    );

    const res = await request(app()).post(`/api/payments/upi/${ORDER}/approve`).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'ALREADY_APPROVED' });
  });

  test('a PaymentError detail is surfaced when present', async () => {
    mockUpi.approve.mockRejectedValueOnce(
      new MockPaymentError('AMOUNT_MISMATCH', 'Amount does not match', 422, { expected: 9000, got: 8900 })
    );

    const res = await request(app()).post(`/api/payments/upi/${ORDER}/approve`).send({});

    expect(res.status).toBe(422);
    expect(res.body.error.detail).toEqual({ expected: 9000, got: 8900 });
  });

  test('an unexpected error is NOT dressed up as a payment error', async () => {
    // sendPaymentError rethrows anything that is not a PaymentError, so it
    // reaches the central handler and is scrubbed. A generic failure must not
    // surface as a 4xx that the UI would present as a business outcome.
    mockUpi.approve.mockRejectedValueOnce(new Error('connection reset'));

    const res = await request(app()).post(`/api/payments/upi/${ORDER}/approve`).send({});

    expect(res.status).toBeGreaterThanOrEqual(500);
    // The central handler answers with a plain string, not the {code,message}
    // envelope sendPaymentError produces — so a caller cannot mistake an
    // infrastructure failure for a business outcome.
    expect(typeof res.body.error).toBe('string');
  });
});

describe('validation on the id parameter', () => {
  test('a non-uuid order id is rejected before any lookup', async () => {
    const res = await request(app()).post('/api/payments/upi/not-a-uuid/approve').send({});

    expect(res.status).toBe(400);
    expect(mockUpi.approve).not.toHaveBeenCalled();
  });
});
