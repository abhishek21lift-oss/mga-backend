// POST /api/webhooks/razorpay — signature verification and dispatch.
//
// Audit finding C-4: this file had no test at all. It is the endpoint through
// which an external party asserts that money moved, so the signature check is
// the only thing standing between "Razorpay said so" and "anyone said so".
//
// What is covered here is the gate: unconfigured secret, missing header,
// wrong/forged/malformed signature, replayed body with a stale signature, and
// dispatch of the three handled event types. Those are correct in the current
// implementation and this pins them.
//
// ── What these tests deliberately do NOT claim ──────────────────────────────
//
// They do not assert the handler bodies work, because they cannot. Every
// UPDATE in this route writes to `payments` columns that do not exist in this
// schema — gateway_payment_id, gateway_status, gateway_payload, refund_id and
// updated_at are absent from schema.sql and from all 154 migrations, and
// razorpay-webhook.js is the only file in the repo that names them. Against a
// real database each UPDATE raises
//
//     ERROR: 42703: column "gateway_status" does not exist
//
// which the route catches and answers with 200 {received:true} so Razorpay
// does not retry. So a captured payment is acknowledged as processed, nothing
// is recorded, and the only trace is a log line.
//
// `payments` is also the legacy gym table (0 rows in production; the live
// tables are pt_payments and subscription_payments), and the only caller of
// lib/razorpay.js is renewal.worker.js, which server.js's own comments
// describe as targeting abandoned tables. The Razorpay path looks vestigial
// end to end rather than half-built.
//
// Fixing that means choosing which table a gateway payment belongs in, and
// that is a product decision, not a test fixture. So the tests below assert
// the dispatch — which event type reaches which branch with which id — and the
// schema mismatch is reported separately rather than frozen into an assertion
// that would bless it.

'use strict';

const crypto = require('crypto');

const SECRET = 'whsec_test_secret_value';

const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 1 };
  }),
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => mockLog);

const express = require('express');
const request = require('supertest');

/**
 * Build an app around a FRESH copy of the router.
 *
 * The route reads RAZORPAY_WEBHOOK_SECRET at module load, so the unconfigured
 * case is only reachable by resetting the module registry with the variable
 * unset. Requiring it once at the top of the file would make that test
 * unwritable.
 */
function appWithSecret(secret) {
  let router;
  jest.isolateModules(() => {
    const prev = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (secret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    router = require('../routes/razorpay-webhook');
    if (prev === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = prev;
  });
  const a = express();
  // Mounted WITHOUT express.json(), matching server.js — the route needs the
  // raw body to verify the signature, and a json parser upstream would consume
  // it and break every check below.
  a.use('/api/webhooks/razorpay', router);
  return a;
}

const sign = (body, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');

const post = (app, body, signature) => {
  const r = request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json');
  if (signature !== undefined) r.set('x-razorpay-signature', signature);
  return r.send(body);
};

const captured = (id = 'pay_ABC123') => JSON.stringify({
  event: 'payment.captured',
  payload: { payment: { entity: { id, amount: 50000, status: 'captured' } } },
});

const writes = () => mockQueries.filter((q) => /UPDATE payments/i.test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  Object.values(mockLog).forEach((f) => f.mockClear && f.mockClear());
});

describe('the signature gate', () => {
  test('refuses every request when no webhook secret is configured', async () => {
    const res = await post(appWithSecret(undefined), captured(), sign(captured()));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/not configured/i);
    // Fails closed: an unconfigured deployment must not accept unverifiable
    // events, which is the one case where accepting would be worse than 500.
    expect(writes()).toHaveLength(0);
  });

  test('rejects a request with no signature header', async () => {
    const res = await post(appWithSecret(SECRET), captured(), undefined);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing signature/i);
    expect(writes()).toHaveLength(0);
  });

  test('rejects a forged signature of the correct length', async () => {
    // Same byte length as a real HMAC-SHA256 digest, so this exercises
    // timingSafeEqual itself rather than the length pre-check.
    const forged = 'a'.repeat(64);
    const res = await post(appWithSecret(SECRET), captured(), forged);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid signature/i);
    expect(writes()).toHaveLength(0);
  });

  test('rejects a signature computed with the wrong secret', async () => {
    const body = captured();
    const res = await post(appWithSecret(SECRET), body, sign(body, 'the-wrong-secret'));

    expect(res.status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  test('rejects a short signature without throwing on the length mismatch', async () => {
    // timingSafeEqual throws if the buffers differ in length, so the route has
    // to compare lengths first. If that guard is ever removed this returns 500
    // instead of 400 and the process logs an uncaught comparison error.
    const res = await post(appWithSecret(SECRET), captured(), 'abcd');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid signature/i);
  });

  test('rejects a non-hex signature without throwing', async () => {
    // Buffer.from('zz...', 'hex') silently yields a short buffer rather than
    // an error, so this lands on the length check — but only by accident, and
    // it should stay covered.
    const res = await post(appWithSecret(SECRET), captured(), 'zz'.repeat(32));

    expect(res.status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  test('rejects a body altered after signing — the replay/tamper case', async () => {
    const original = captured('pay_ORIGINAL');
    const signature = sign(original);
    // Same signature, different amount. This is the attack the HMAC exists for.
    const tampered = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_ORIGINAL', amount: 999999999, status: 'captured' } } },
    });

    const res = await post(appWithSecret(SECRET), tampered, signature);

    expect(res.status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  test('accepts a correctly signed body', async () => {
    const body = captured();
    const res = await post(appWithSecret(SECRET), body, sign(body));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  test('rejects valid-signature-but-invalid-JSON', async () => {
    const body = '{ not json at all';
    const res = await post(appWithSecret(SECRET), body, sign(body));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid json/i);
  });
});

describe('event dispatch', () => {
  const app = () => appWithSecret(SECRET);
  const send = (body) => post(app(), body, sign(body));

  test('payment.captured marks the payment captured by gateway id', async () => {
    await send(captured('pay_CAPTURE_1'));

    const [q] = writes();
    expect(q.sql).toMatch(/gateway_status = 'captured'/i);
    expect(q.params[0]).toBe('pay_CAPTURE_1');
  });

  test('payment.failed marks the payment failed', async () => {
    const body = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_FAIL_1', error_reason: 'card_declined' } } },
    });
    await send(body);

    const [q] = writes();
    expect(q.sql).toMatch(/gateway_status = 'failed'/i);
    expect(q.params[0]).toBe('pay_FAIL_1');
  });

  test('refund.processed keys off payment_id, not the refund id', async () => {
    // The refund entity carries both. Writing WHERE gateway_payment_id =
    // refund.id would silently match nothing and leave the payment unrefunded.
    const body = JSON.stringify({
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_REFUNDED_1' } } },
    });
    await send(body);

    const [q] = writes();
    expect(q.sql).toMatch(/gateway_status = 'refunded'/i);
    expect(q.params[0]).toBe('pay_REFUNDED_1');
    expect(q.params[1]).toBe('rfnd_1');
  });

  test('an unknown event type is acknowledged and ignored', async () => {
    const body = JSON.stringify({ event: 'subscription.charged', payload: {} });
    const res = await send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(writes()).toHaveLength(0);
  });

  test('a handled event with no payment entity writes nothing', async () => {
    // Razorpay has sent malformed payloads before; a missing entity must not
    // produce an UPDATE with an undefined id.
    const body = JSON.stringify({ event: 'payment.captured', payload: {} });
    const res = await send(body);

    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(0);
  });
});

describe('failure handling', () => {
  test('a database error is answered 5xx, so the event is not lost', async () => {
    // This test used to assert the opposite, and said so: it pinned the 200 as
    // "current behaviour, not endorsing it", and predicted that a write failing
    // for any reason would be indistinguishable to the sender from success.
    //
    // That prediction was already true in production. `payments` has none of
    // the columns the route writes, so every event raised 42703 and was
    // acknowledged anyway — Razorpay was told "processed", correctly never
    // resent it, and the write was lost with one log line as its only trace.
    //
    // The expectation changed because the behaviour was wrong, not because the
    // test was inconvenient. A 5xx asks the provider to retry: right for a
    // transient fault, and loud rather than invisible for a permanent one.
    const pool = require('../db/pool');
    pool.query.mockRejectedValueOnce(new Error('column "gateway_status" does not exist'));

    const body = captured('pay_DBERR');
    const res = await post(appWithSecret(SECRET), body, sign(body));

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body).toEqual({ received: false });
    expect(mockLog.error).toHaveBeenCalled();
  });
});
