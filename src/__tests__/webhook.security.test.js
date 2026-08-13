'use strict';

/**
 * Inbound webhook security — Razorpay.
 *
 * The question this file exists to answer is narrow: can an attacker cause a
 * webhook meant for one tenant to act on another, or choose a tenant itself?
 *
 * For this handler the answer is structural rather than defensive. Tenant
 * identity is never established from the request at all: the row is located by
 * the provider's own payment id, which Razorpay allocates globally. There is
 * no organization_id anywhere on the path to forge. These tests pin that
 * property, because the dangerous version of this code — reading a tenant id
 * out of a signed body and trusting it because the signature checked out — is
 * one edit away and would still pass every signature test.
 *
 * The pool is mocked. What matters here is which SQL runs and with which
 * arguments, and above all whether any SQL runs at all before the signature is
 * verified; none of that needs a database, and mocking makes the "no side
 * effect" assertions exact rather than inferred.
 */

// The mock implements gateway_record_event's real signature — it RETURNS
// TABLE (transaction_id, organization_id, applied). A bare empty result would
// send every test down the route's "unknown payment" branch and let the
// assertions below pass for the wrong reason.
const GATEWAY_OK = { rows: [{ transaction_id: 'txn-1', organization_id: 'org-1', applied: true }], rowCount: 1 };
jest.mock('../db/pool', () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const SECRET = 'test_webhook_secret_not_a_real_one';

/**
 * A fresh app per test, because the router reads RAZORPAY_WEBHOOK_SECRET once
 * at require time. resetModules() also rebuilds the pool mock, so the live
 * instance is handed back with the app — holding a reference from the top of
 * this file would silently observe a mock the route never used.
 */
function makeApp(secret = SECRET) {
  jest.resetModules();
  process.env.RAZORPAY_WEBHOOK_SECRET = secret;
  const pool = require('../db/pool');
  pool.query.mockResolvedValue(GATEWAY_OK);
  const app = express();
  // Mounted exactly as server.js does: before any JSON parser, so the router's
  // own express.raw() sees the untouched bytes.
  app.use('/api/webhooks/razorpay', require('../routes/razorpay-webhook'));
  return { app, pool };
}

const sign = (body, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

const paymentEvent = (event, id, extra = {}) => JSON.stringify({
  event,
  ...extra,
  payload: {
    payment: { entity: { id, amount: 50000, currency: 'INR' } },
    refund: { entity: { id: 'rfnd_test_1', payment_id: id } },
  },
});

function post(app, body, signature) {
  const r = request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json');
  if (signature !== null) r.set('x-razorpay-signature', signature);
  return r.send(body);          // raw string: a Buffer would be re-serialised
}

describe('Razorpay webhook — signature is the gate', () => {
  it('accepts a correctly signed event', async () => {
    const { app, pool } = makeApp();
    const body = paymentEvent('payment.captured', 'pay_valid_1');
    const res = await post(app, body, sign(body));
    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid signature without touching the database', async () => {
    const { app, pool } = makeApp();
    const body = paymentEvent('payment.captured', 'pay_evil_1');
    const res = await post(app, body, sign(body, 'attacker-guess'));
    expect(res.status).toBe(400);
    // The property that matters: refusal happens BEFORE any side effect.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a missing signature header', async () => {
    const { app, pool } = makeApp();
    const res = await post(app, paymentEvent('payment.captured', 'pay_x'), null);
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a body modified after signing — raw bytes are what is verified', async () => {
    const { app, pool } = makeApp();
    const original = paymentEvent('payment.captured', 'pay_original');
    const swapped = paymentEvent('payment.captured', 'pay_attacker_owned');
    // Same signature, different body: the classic parser-vs-verifier gap that
    // appears when a JSON middleware runs before the signature check.
    const res = await post(app, swapped, sign(original));
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('refuses to run at all when no secret is configured', async () => {
    const { app, pool } = makeApp('');
    const body = paymentEvent('payment.captured', 'pay_x');
    const res = await post(app, body, sign(body));
    expect(res.status).toBe(500);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON after the signature passes', async () => {
    const { app, pool } = makeApp();
    const res = await post(app, '{not json', sign('{not json'));
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('Razorpay webhook — tenant identity cannot be supplied by the caller', () => {
  it('ignores organization_id even inside a correctly signed body', async () => {
    const { app, pool } = makeApp();
    const body = paymentEvent('payment.captured', 'pay_tenant_test', {
      organization_id: '11111111-1111-1111-1111-111111111111',
      org_id: '22222222-2222-2222-2222-222222222222',
    });
    const res = await post(app, body, sign(body));
    expect(res.status).toBe(200);

    // A valid signature proves the message came from Razorpay. It proves
    // nothing about which tenant it may act on, and the handler must not treat
    // it as if it did.
    const [, args] = pool.query.mock.calls[0];
    // gateway_record_event has no organization_id parameter at all, so the
    // forged values cannot appear among the arguments — there is nowhere to
    // put them. That is a stronger property than "the SQL was filtered".
    expect(JSON.stringify(args)).not.toContain('11111111-1111-1111-1111-111111111111');
    expect(JSON.stringify(args)).not.toContain('22222222-2222-2222-2222-222222222222');
    expect(args).toHaveLength(6);
  });

  it('locates the row solely by the provider payment id', async () => {
    const { app, pool } = makeApp();
    const body = paymentEvent('payment.captured', 'pay_ownership_1');
    await post(app, body, sign(body));

    const [sql, args] = pool.query.mock.calls[0];
    // Razorpay allocates payment ids globally, so this identifies one row on
    // the platform. Ownership follows from the row the function finds, not
    // from anything in the message.
    expect(sql).toMatch(/gateway_record_event/);
    expect(args[0]).toBe('razorpay');
    expect(args[1]).toBe('pay_ownership_1');
  });

  it('never establishes tenant context from the request', async () => {
    const src = require('node:fs')
      .readFileSync(require.resolve('../routes/razorpay-webhook'), 'utf8');
    expect(src).not.toMatch(/runWithTenantContext/);
    expect(src).not.toMatch(/req\.body\.organization_id|event\.organization_id/);
    expect(src).not.toMatch(/set_config/);
  });
});

describe('Razorpay webhook — unknown and repeated events', () => {
  it('acknowledges an unknown event type without writing', async () => {
    const { app, pool } = makeApp();
    const body = paymentEvent('order.paid', 'pay_unknown_evt');
    const res = await post(app, body, sign(body));
    expect(res.status).toBe(200);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a handled event that carries no payment id, and writes nothing', async () => {
    const { app, pool } = makeApp();
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: {} } } });
    const res = await post(app, body, sign(body));
    // 4xx rather than the acknowledgement this used to expect: a
    // payment.captured with no payment is malformed, it is the caller's
    // fault, and retrying the same payload cannot help.
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('is replay-safe because every write is an absolute status, not an increment', async () => {
    const { app, pool } = makeApp();
    const body = paymentEvent('payment.captured', 'pay_replay_1');
    await post(app, body, sign(body));
    await post(app, body, sign(body));

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [first] = pool.query.mock.calls[0];
    const [second] = pool.query.mock.calls[1];
    expect(first).toBe(second);
    // There is no event-id ledger here, so replay safety rests entirely on the
    // writes being idempotent. Anything that accumulates — a credit, a wallet
    // balance, a commission — would need one, and this assertion is what fails
    // if such a statement is ever added.
    expect(first).not.toMatch(/\+\s*\$|\+\s*\d|COALESCE\([^)]*\)\s*\+/);
  });
});

describe('Razorpay webhook — a failed write is never reported as success', () => {
  it('answers 5xx when the database rejects the write, so the provider retries', async () => {
    const { app, pool } = makeApp();
    // Exactly today's production failure: `payments` has no gateway_payment_id.
    pool.query.mockRejectedValueOnce(
      Object.assign(new Error('column "gateway_payment_id" does not exist'), { code: '42703' }),
    );
    const body = paymentEvent('payment.captured', 'pay_db_error');
    const res = await post(app, body, sign(body));

    // A 200 here tells Razorpay the event is handled and it is never resent.
    // The write did not happen, so that is silent, permanent data loss.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body).toEqual({ received: false });
  });

  it('still refuses a bad signature with 4xx, which must never be retried', async () => {
    const { app } = makeApp();
    const body = paymentEvent('payment.captured', 'pay_sig');
    const res = await post(app, body, sign(body, 'wrong'));
    // The caller is at fault, not us: retrying cannot help and a 5xx would ask
    // Razorpay to hammer an endpoint that will keep refusing.
    expect(res.status).toBe(400);
  });
});
