// Flow tests for the studio → platform subscription checkout.
//
// This is the OTHER payment direction: a studio admin paying MY PT STUDIO for
// its own subscription, verified by hand in the command centre. The failure
// modes worth testing here are not the same as the member→studio ones:
//
//   - a studio must never be shown a QR before the operator has a real VPA
//   - the amount must come from the server, never from the request body
//   - pricing for an ALREADY ACTIVE studio must net out its proration credit,
//     not just quote the plan's sticker price — this is the bug that let an
//     upgrading studio skip payment entirely and go through a manual,
//     un-verified request instead
//   - a downgrade must never be checked out — it's free and scheduled, not paid
//   - a second "Pay" tap must not create a second queue entry
//   - two operators approving at once must not activate twice
//   - an activation that fails must NOT leave the request marked approved
//   - a rejection must send the studio back to payable WITH an explanation
//
// As in upiPayments.flow.test.js the pool is a scriptable mock so the tests
// can assert the SQL guards themselves — a test that only checked the return
// value would pass against an UPDATE with no WHERE-status clause.
'use strict';

// ── Scriptable pool mock ────────────────────────────────────────────────────
const state = { handlers: [], log: [] };

function makeClient() {
  return {
    query: jest.fn(async (sql, params) => {
      // Matched against WHITESPACE-FLATTENED sql: the queries in
      // subscriptionCheckout.js are multi-line template literals, so a
      // single-line pattern would otherwise miss for cosmetic reasons.
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      state.log.push({ sql: flat, params });
      for (const h of state.handlers) {
        if (h.match.test(flat)) {
          if (h.throws) throw h.throws;
          return typeof h.result === 'function' ? h.result(params) : h.result;
        }
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
}

// Jest only lets a mock factory close over names prefixed with "mock".
let mockCurrentClient;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => mockCurrentClient.query(sql, params)),
  connect: jest.fn(async () => mockCurrentClient),
}));

// subscription.js owns pricing (quotePlanChange), activation, founder pricing
// and coupon redemption. Mocked because this module's contract is "delegate
// to it correctly", not "reimplement it" — subscription.proration/coupons
// tests cover quotePlanChange's/activate's own internals.
jest.mock('../lib/subscription', () => ({
  quotePlanChange: jest.fn(),
  validateCoupon: jest.fn(),
  activate: jest.fn(),
  logEvent: jest.fn(async () => {}),
}));

const subscription = require('../lib/subscription');
const checkout = require('../lib/subscriptionCheckout');

function on(match, result) { state.handlers.push({ match, result }); }
function onThrow(match, error) { state.handlers.push({ match, throws: error }); }
function sqlLog() { return state.log.map((e) => e.sql); }
function ranSql(re) { return sqlLog().some((s) => re.test(s)); }
function paramsOf(re) { return (state.log.find((e) => re.test(e.sql)) || {}).params; }

const ORG = '11111111-1111-1111-1111-111111111111';
const REQ_ID = '22222222-2222-2222-2222-222222222222';
const ACTOR = { id: 'usr-admin', name: 'Studio Admin', role: 'admin' };
const OPERATOR = { id: 'usr-super', name: 'Platform', role: 'super_admin' };

const SETTINGS = {
  upi_id: 'myptstudio@okicici',
  merchant_name: 'MY PT STUDIO',
  instructions: 'Verified within 2 hours',
  is_enabled: true,
  request_ttl_minutes: 60,
};

function aRequest(overrides = {}) {
  return {
    id: REQ_ID,
    organization_id: ORG,
    request_no: 'SUB-202607-05001',
    plan_code: 'pro',
    list_price_inr: 2999,
    discount_inr: 0,
    amount_inr: 2999,
    coupon_code: null,
    direction: 'activation',
    proration_credit_inr: 0,
    previous_plan_code: null,
    upi_id: SETTINGS.upi_id,
    merchant_name: SETTINGS.merchant_name,
    status: checkout.REQUEST_STATUS.AWAITING_PAYMENT,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    utr: null,
    ...overrides,
  };
}

/** subscription.quotePlanChange()'s return shape, defaulted to a plain
    first-time activation — no current plan, no proration credit. */
function aQuote(overrides = {}) {
  return {
    direction: 'activation',
    immediate: true,
    current_plan: null,
    new_plan: { code: 'pro', name: 'Pro', client_limit: 30, duration_months: 1 },
    new_plan_price_inr: 2999,
    proration_credit_inr: 0,
    amount_due_inr: 2999,
    is_launch_price: false,
    founder_locked: false,
    effective_at: new Date().toISOString(),
    active_clients: 0,
    new_client_limit: 30,
    over_limit_by: 0,
    warning: null,
    ...overrides,
  };
}

/** The happy-path scripting shared by the pricing tests. */
function scriptPricing(overrides = {}) {
  subscription.quotePlanChange.mockResolvedValue(aQuote(overrides));
}

beforeEach(() => {
  state.handlers = [];
  state.log = [];
  mockCurrentClient = makeClient();
  jest.clearAllMocks();
  subscription.logEvent.mockResolvedValue(undefined);
});

// ════════════════════════════════════════════════════════════════════════════
//  PLATFORM SETTINGS — fail closed
// ════════════════════════════════════════════════════════════════════════════

describe('platform payee settings', () => {
  test('no settings row at all → checkout is refused, not defaulted', async () => {
    on(/FROM platform_payment_settings/, { rows: [] });
    await expect(checkout.requirePlatformSettings())
      .rejects.toMatchObject({ code: 'PLATFORM_PAYMENTS_NOT_CONFIGURED', status: 409 });
  });

  test('settings present but switched off → refused', async () => {
    on(/FROM platform_payment_settings/, { rows: [{ ...SETTINGS, is_enabled: false }] });
    await expect(checkout.requirePlatformSettings())
      .rejects.toMatchObject({ code: 'PLATFORM_PAYMENTS_DISABLED', status: 409 });
  });

  test('a malformed VPA that reached the table is still rejected at read time', async () => {
    // Belt and braces: the column has a CHECK, but a settings row written
    // before that constraint existed must not produce a QR pointing nowhere.
    on(/FROM platform_payment_settings/, { rows: [{ ...SETTINGS, upi_id: 'not-a-vpa' }] });
    await expect(checkout.requirePlatformSettings()).rejects.toBeInstanceOf(Error);
  });

  test('saving settings rejects a malformed VPA before it touches the table', async () => {
    await expect(checkout.savePlatformSettings(
      { upi_id: 'nope', merchant_name: 'X' }, OPERATOR.id
    )).rejects.toBeInstanceOf(Error);
    expect(ranSql(/INSERT INTO platform_payment_settings/)).toBe(false);
  });

  test('saving is an upsert pinned to the singleton row', async () => {
    on(/INSERT INTO platform_payment_settings/, { rows: [SETTINGS] });
    await checkout.savePlatformSettings(SETTINGS, OPERATOR.id);
    expect(ranSql(/INSERT INTO platform_payment_settings .* ON CONFLICT \(singleton\) DO UPDATE/)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  PRICING — the server decides, and it decides the SAME WAY for a brand-new
//  subscription and an already-active studio's upgrade/renewal
// ════════════════════════════════════════════════════════════════════════════

describe('pricing', () => {
  test('a first-time activation is priced at the full quoted amount', async () => {
    scriptPricing({ direction: 'activation', new_plan_price_inr: 2999, amount_due_inr: 2999 });
    const p = await checkout.priceFor(ORG, 'pro');
    expect(p.amount_inr).toBe(2999);
    expect(p.list_price_inr).toBe(2999);
    expect(p.discount_inr).toBe(0);
    expect(p.direction).toBe('activation');
    expect(p.previous_plan_code).toBeNull();
  });

  // The bug this fixes: an already-active studio upgrading was previously
  // priced (and activated) through an entirely separate, unpaid path. Now it
  // goes through the exact same pricing engine as a fresh subscription —
  // quotePlanChange() — so the amount already has proration credit netted out.
  test('an upgrade for an ACTIVE studio is priced net of its proration credit, not the sticker price', async () => {
    scriptPricing({
      direction: 'upgrade',
      current_plan: { code: 'starter', name: 'Starter', client_limit: 5 },
      new_plan_price_inr: 4999,
      proration_credit_inr: 1200,
      amount_due_inr: 3799,
    });
    const p = await checkout.priceFor(ORG, 'growth');
    expect(p.amount_inr).toBe(3799);
    expect(p.list_price_inr).toBe(3799);
    expect(p.direction).toBe('upgrade');
    expect(p.previous_plan_code).toBe('starter');
    expect(p.proration_credit_inr).toBe(1200);
  });

  test('a renewal of the current plan is also priced through quotePlanChange, net of credit', async () => {
    scriptPricing({
      direction: 'renewal',
      current_plan: { code: 'pro', name: 'Pro', client_limit: 30 },
      new_plan_price_inr: 2999,
      proration_credit_inr: 400,
      amount_due_inr: 2599,
    });
    const p = await checkout.priceFor(ORG, 'pro');
    expect(p.amount_inr).toBe(2599);
    expect(p.direction).toBe('renewal');
  });

  // Downgrades are free and take effect at period end — scheduleDowngrade()
  // handles those with no payment involved. A downgrade must never reach the
  // paid checkout path at all.
  test('a downgrade cannot be checked out — there is nothing to pay', async () => {
    scriptPricing({ direction: 'downgrade', amount_due_inr: 0 });
    await expect(checkout.priceFor(ORG, 'starter'))
      .rejects.toMatchObject({ code: 'DOWNGRADE_NOT_PAYABLE', status: 400 });
  });

  test('a founder studio prices at its locked price — quotePlanChange already applied it', async () => {
    scriptPricing({ new_plan_price_inr: 999, amount_due_inr: 999, founder_locked: true });
    const p = await checkout.priceFor(ORG, 'pro');
    expect(p.amount_inr).toBe(999);
  });

  test('a valid coupon reduces the amount and is recorded for redemption at approval', async () => {
    scriptPricing({ amount_due_inr: 2999 });
    subscription.validateCoupon.mockResolvedValue({ valid: true, discount_inr: 500 });
    const p = await checkout.priceFor(ORG, 'pro', 'launch50');
    expect(p.discount_inr).toBe(500);
    expect(p.amount_inr).toBe(2499);
    expect(p.coupon_code).toBe('LAUNCH50');
  });

  test('an invalid coupon does not block checkout — the studio just pays full price', async () => {
    scriptPricing({ amount_due_inr: 2999 });
    subscription.validateCoupon.mockRejectedValue(new Error('expired'));
    const p = await checkout.priceFor(ORG, 'pro', 'DEAD');
    expect(p.amount_inr).toBe(2999);
    expect(p.coupon_code).toBeNull();
  });

  test('a coupon larger than the amount due cannot make the price negative or zero', async () => {
    // UPI apps reject a zero-rupee intent, so this path must refuse rather
    // than generate a QR the studio can never pay.
    scriptPricing({ amount_due_inr: 2999 });
    subscription.validateCoupon.mockResolvedValue({ valid: true, discount_inr: 5000 });
    await expect(checkout.priceFor(ORG, 'pro', 'FREE'))
      .rejects.toMatchObject({ code: 'NOTHING_TO_PAY', status: 409 });
  });

  test('a renewal fully covered by proration credit also refuses rather than checking out for ₹0', async () => {
    scriptPricing({ direction: 'renewal', amount_due_inr: 0 });
    await expect(checkout.priceFor(ORG, 'pro'))
      .rejects.toMatchObject({ code: 'NOTHING_TO_PAY', status: 409 });
  });

  test('an unknown plan surfaces the 400 the shared pricing engine raises', async () => {
    subscription.quotePlanChange.mockRejectedValue(Object.assign(new Error('Unknown plan'), { status: 400 }));
    await expect(checkout.priceFor(ORG, 'nope')).rejects.toMatchObject({ status: 400 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  OPENING A CHECKOUT
// ════════════════════════════════════════════════════════════════════════════

describe('openCheckout', () => {
  beforeEach(() => {
    on(/FROM platform_payment_settings/, { rows: [SETTINGS] });
    scriptPricing({ amount_due_inr: 2999 });
  });

  test('the amount is written from server pricing and the payee is snapshotted', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.organization_id = \$1 AND r\.status = ANY/, { rows: [] });
    on(/SELECT nextval\('subscription_request_no_seq'\)/, { rows: [{ n: 5001 }] });
    on(/INSERT INTO subscription_payment_requests/, { rows: [aRequest()] });

    const { request, reused } = await checkout.openCheckout({ orgId: ORG, planCode: 'pro', actor: ACTOR });

    expect(reused).toBe(false);
    const p = paramsOf(/INSERT INTO subscription_payment_requests/);
    expect(p).toContain(2999);                    // amount_inr
    expect(p).toContain(SETTINGS.upi_id);         // payee frozen onto the row
    expect(p).toContain(SETTINGS.merchant_name);
    expect(request.amount_inr).toBe(2999);
  });

  test('an upgrade writes its direction, credit and previous plan onto the row', async () => {
    scriptPricing({
      direction: 'upgrade',
      current_plan: { code: 'starter', name: 'Starter', client_limit: 5 },
      new_plan_price_inr: 4999,
      proration_credit_inr: 1200,
      amount_due_inr: 3799,
    });
    on(/FROM subscription_payment_requests r WHERE r\.organization_id = \$1 AND r\.status = ANY/, { rows: [] });
    on(/SELECT nextval/, { rows: [{ n: 5005 }] });
    on(/INSERT INTO subscription_payment_requests/,
      { rows: [aRequest({ direction: 'upgrade', proration_credit_inr: 1200, previous_plan_code: 'starter', amount_inr: 3799 })] });

    await checkout.openCheckout({ orgId: ORG, planCode: 'growth', actor: ACTOR });

    const p = paramsOf(/INSERT INTO subscription_payment_requests/);
    expect(p).toContain('upgrade');
    expect(p).toContain(1200);
    expect(p).toContain('starter');
  });

  test('a second tap on the same plan reuses the open request instead of queueing twice', async () => {
    const open = aRequest();
    on(/FROM subscription_payment_requests r WHERE r\.organization_id = \$1 AND r\.status = ANY/, { rows: [open] });

    const { request, reused } = await checkout.openCheckout({ orgId: ORG, planCode: 'pro', actor: ACTOR });

    expect(reused).toBe(true);
    expect(request.id).toBe(REQ_ID);
    expect(ranSql(/INSERT INTO subscription_payment_requests/)).toBe(false);
  });

  test('switching plans retires the old request so the one-open-per-org index frees up', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.organization_id = \$1 AND r\.status = ANY/,
      { rows: [aRequest({ plan_code: 'starter' })] });
    on(/SELECT nextval/, { rows: [{ n: 5002 }] });
    on(/INSERT INTO subscription_payment_requests/, { rows: [aRequest()] });

    const { reused } = await checkout.openCheckout({ orgId: ORG, planCode: 'pro', actor: ACTOR });

    expect(reused).toBe(false);
    const cancelParams = paramsOf(/UPDATE subscription_payment_requests SET status = \$1 WHERE id = \$2/);
    expect(cancelParams[0]).toBe(checkout.REQUEST_STATUS.CANCELLED);
  });

  test('the open-request lookup takes a row lock, so two taps cannot both insert', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.organization_id = \$1 AND r\.status = ANY/, { rows: [] });
    on(/SELECT nextval/, { rows: [{ n: 5003 }] });
    on(/INSERT INTO subscription_payment_requests/, { rows: [aRequest()] });

    await checkout.openCheckout({ orgId: ORG, planCode: 'pro', actor: ACTOR });

    expect(ranSql(/FROM subscription_payment_requests r WHERE r\.organization_id = \$1 AND r\.status = ANY\(\$2::text\[\]\) FOR UPDATE/)).toBe(true);
  });

  test('a failure mid-transaction rolls back rather than leaving a half-open checkout', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.organization_id = \$1 AND r\.status = ANY/, { rows: [] });
    on(/SELECT nextval/, { rows: [{ n: 5004 }] });
    onThrow(/INSERT INTO subscription_payment_requests/, new Error('db down'));

    await expect(checkout.openCheckout({ orgId: ORG, planCode: 'pro', actor: ACTOR })).rejects.toThrow('db down');
    expect(ranSql(/^ROLLBACK$/)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  THE QR — built from the row, not from the browser
// ════════════════════════════════════════════════════════════════════════════

describe('buildCheckoutView', () => {
  test('the intent carries the stored payee and the stored amount', async () => {
    const view = await checkout.buildCheckoutView(aRequest());
    expect(view.intent_url).toContain(`pa=${encodeURIComponent(SETTINGS.upi_id)}`);
    expect(view.intent_url).toMatch(/[?&]am=2999(\.00)?(&|$)/);
    expect(view.intent_url).toMatch(/[?&]cu=INR(&|$)/);
    expect(view.qr_data_url).toMatch(/^data:image\/(png|svg\+xml)/);
  });

  test('a discounted request encodes the discounted amount, never the list price', async () => {
    const view = await checkout.buildCheckoutView(
      aRequest({ list_price_inr: 2999, discount_inr: 500, amount_inr: 2499 })
    );
    expect(view.intent_url).toMatch(/[?&]am=2499(\.00)?(&|$)/);
    expect(view.intent_url).not.toMatch(/am=2999/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  SUBMITTING THE UTR
// ════════════════════════════════════════════════════════════════════════════

describe('submitUtr', () => {
  test('the transition is conditional on the request still awaiting payment', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.id = \$1 AND r\.organization_id = \$2 FOR UPDATE/,
      { rows: [aRequest()] });
    on(/UPDATE subscription_payment_requests SET status = \$1, utr = \$2/,
      { rows: [aRequest({ status: 'AWAITING_VERIFICATION', utr: '123456789012' })] });

    await checkout.submitUtr({
      requestId: REQ_ID, orgId: ORG, utr: '123456789012', actor: ACTOR,
    });

    expect(ranSql(/UPDATE subscription_payment_requests SET status = \$1, utr = \$2.*WHERE id = \$6 AND status = \$7/)).toBe(true);
  });

  test('a UTR already claimed anywhere on the platform is surfaced as DUPLICATE_UTR', async () => {
    // Platform-wide, deliberately: one payee means a UTR reused across two
    // studios is one of them claiming the other studio's transfer.
    on(/FROM subscription_payment_requests r WHERE r\.id = \$1 AND r\.organization_id = \$2 FOR UPDATE/,
      { rows: [aRequest()] });
    onThrow(/UPDATE subscription_payment_requests SET status = \$1, utr = \$2/,
      Object.assign(new Error('duplicate key'), {
        code: '23505', constraint: 'uq_sub_pay_req_live_utr',
      }));

    await expect(checkout.submitUtr({
      requestId: REQ_ID, orgId: ORG, utr: '123456789012', actor: ACTOR,
    })).rejects.toMatchObject({ code: 'DUPLICATE_UTR', status: 409 });

    expect(ranSql(/^ROLLBACK$/)).toBe(true);
  });

  test('a request that is no longer payable is a 409, not a silent overwrite', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.id = \$1 AND r\.organization_id = \$2 FOR UPDATE/,
      { rows: [aRequest({ status: 'APPROVED' })] });

    await expect(checkout.submitUtr({
      requestId: REQ_ID, orgId: ORG, utr: '123456789012', actor: ACTOR,
    })).rejects.toMatchObject({ code: 'NOT_AWAITING_PAYMENT', status: 409 });
  });

  test('an expired request cannot be paid into', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.id = \$1 AND r\.organization_id = \$2 FOR UPDATE/,
      { rows: [aRequest({ expires_at: new Date(Date.now() - 1000).toISOString() })] });

    await expect(checkout.submitUtr({
      requestId: REQ_ID, orgId: ORG, utr: '123456789012', actor: ACTOR,
    })).rejects.toMatchObject({ code: 'REQUEST_EXPIRED', status: 409 });
  });

  test('another studio cannot submit against this request — the lookup is org-scoped', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.id = \$1 AND r\.organization_id = \$2 FOR UPDATE/, { rows: [] });

    await expect(checkout.submitUtr({
      requestId: REQ_ID, orgId: 'someone-else', utr: '123456789012', actor: ACTOR,
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  test('resubmitting after a rejection clears the stale rejection note', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.id = \$1 AND r\.organization_id = \$2 FOR UPDATE/,
      { rows: [aRequest({ rejected_note: 'Wrong reference' })] });
    on(/UPDATE subscription_payment_requests SET status = \$1, utr = \$2/,
      { rows: [aRequest({ status: 'AWAITING_VERIFICATION', utr: '999888777666' })] });

    await checkout.submitUtr({ requestId: REQ_ID, orgId: ORG, utr: '999888777666', actor: ACTOR });

    expect(ranSql(/rejected_note = NULL, reviewed_by = NULL, reviewed_at = NULL/)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  APPROVAL
// ════════════════════════════════════════════════════════════════════════════

describe('approve', () => {
  const submitted = (overrides = {}) => aRequest({
    status: 'AWAITING_VERIFICATION', utr: '123456789012', organization_name: 'Iron House', ...overrides,
  });

  test('a first-time activation does NOT pass resetPeriod/prorationCreditInr — nothing to reset', async () => {
    on(/FROM subscription_payment_requests r JOIN organizations o/, { rows: [submitted()] });
    on(/UPDATE subscription_payment_requests SET status = \$1, reviewed_by = \$2/, { rows: [], rowCount: 1 });
    subscription.activate.mockResolvedValue({ invoice_no: 'INV-1' });

    await checkout.approve({ requestId: REQ_ID, actor: OPERATOR });

    expect(subscription.activate).toHaveBeenCalledWith(ORG, 'pro', expect.objectContaining({
      amount_inr: 2999, method: 'upi', reference: '123456789012',
    }));
    expect(subscription.activate.mock.calls[0][2]).not.toHaveProperty('resetPeriod');
    // A fresh activation isn't a "plan change" — no extra activity-log entry.
    expect(subscription.logEvent).not.toHaveBeenCalledWith(
      expect.anything(), ORG, 'plan_changed', expect.anything(), expect.anything()
    );
  });

  // The bug: an upgrade approved through self-checkout must produce the exact
  // same activate() call shape as subscription.changePlan() does for an
  // operator-executed upgrade — resetPeriod:true (the credited time was
  // already paid out in a smaller charge, so stacking it again would be a
  // double credit), plus the frozen proration credit and previous plan for
  // the invoice/payment record.
  test('an upgrade passes resetPeriod, the frozen proration credit and the previous plan to activate()', async () => {
    on(/FROM subscription_payment_requests r JOIN organizations o/, {
      rows: [submitted({
        direction: 'upgrade', previous_plan_code: 'starter', proration_credit_inr: 1200, amount_inr: 3799,
      })],
    });
    on(/UPDATE subscription_payment_requests SET status = \$1, reviewed_by = \$2/, { rows: [], rowCount: 1 });
    subscription.activate.mockResolvedValue({ invoice_no: 'INV-UP' });

    await checkout.approve({ requestId: REQ_ID, actor: OPERATOR });

    expect(subscription.activate).toHaveBeenCalledWith(ORG, 'pro', expect.objectContaining({
      amount_inr: 3799, resetPeriod: true, prorationCreditInr: 1200, previousPlanCode: 'starter',
    }));
    expect(subscription.logEvent).toHaveBeenCalledWith(
      expect.anything(), ORG, 'plan_changed',
      expect.objectContaining({ from: 'starter', to: 'pro', direction: 'upgrade', charged_inr: 3799 }),
      OPERATOR
    );
  });

  test('a renewal is treated as a change too — resetPeriod passed, previous plan is the same plan', async () => {
    on(/FROM subscription_payment_requests r JOIN organizations o/, {
      rows: [submitted({
        direction: 'renewal', previous_plan_code: 'pro', proration_credit_inr: 400, amount_inr: 2599,
      })],
    });
    on(/UPDATE subscription_payment_requests SET status = \$1, reviewed_by = \$2/, { rows: [], rowCount: 1 });
    subscription.activate.mockResolvedValue({ invoice_no: 'INV-REN' });

    await checkout.approve({ requestId: REQ_ID, actor: OPERATOR });

    expect(subscription.activate).toHaveBeenCalledWith(ORG, 'pro', expect.objectContaining({
      resetPeriod: true, prorationCreditInr: 400, previousPlanCode: 'pro',
    }));
  });

  test('a coupon is handed to activate() under the key it actually reads', async () => {
    // opts.couponCode, not coupon_code. The snake_case spelling would have
    // charged the discounted amount while leaving the coupon unredeemed.
    on(/FROM subscription_payment_requests r JOIN organizations o/,
      { rows: [submitted({ coupon_code: 'LAUNCH50', amount_inr: 2499 })] });
    on(/UPDATE subscription_payment_requests SET status = \$1, reviewed_by = \$2/, { rows: [], rowCount: 1 });
    subscription.activate.mockResolvedValue({ invoice_no: 'INV-2' });

    await checkout.approve({ requestId: REQ_ID, actor: OPERATOR });

    expect(subscription.activate.mock.calls[0][2]).toMatchObject({ couponCode: 'LAUNCH50' });
  });

  test('two operators approving at once: the loser gets a 409 and activate() runs once', async () => {
    on(/FROM subscription_payment_requests r JOIN organizations o/, { rows: [submitted()] });
    // The conditional UPDATE matches nothing — someone else already flipped it.
    on(/UPDATE subscription_payment_requests SET status = \$1, reviewed_by = \$2/, { rows: [], rowCount: 0 });

    await expect(checkout.approve({ requestId: REQ_ID, actor: OPERATOR }))
      .rejects.toMatchObject({ code: 'CONCURRENT_UPDATE', status: 409 });
    expect(subscription.activate).not.toHaveBeenCalled();
  });

  test('the approving UPDATE is guarded by the expected status', async () => {
    on(/FROM subscription_payment_requests r JOIN organizations o/, { rows: [submitted()] });
    on(/UPDATE subscription_payment_requests SET status = \$1, reviewed_by = \$2/, { rows: [], rowCount: 1 });
    subscription.activate.mockResolvedValue({});

    await checkout.approve({ requestId: REQ_ID, actor: OPERATOR });

    expect(ranSql(/UPDATE subscription_payment_requests SET status = \$1, reviewed_by = \$2, reviewed_at = NOW\(\) WHERE id = \$3 AND status = \$4/)).toBe(true);
    const p = paramsOf(/UPDATE subscription_payment_requests SET status = \$1, reviewed_by = \$2/);
    expect(p[3]).toBe(checkout.REQUEST_STATUS.AWAITING_VERIFICATION);
  });

  test('if activation fails the request goes BACK to the queue, not left marked approved', async () => {
    on(/FROM subscription_payment_requests r JOIN organizations o/, { rows: [submitted()] });
    on(/UPDATE subscription_payment_requests SET status = \$1, reviewed_by = \$2/, { rows: [], rowCount: 1 });
    subscription.activate.mockRejectedValue(new Error('coupon exhausted'));

    await expect(checkout.approve({ requestId: REQ_ID, actor: OPERATOR })).rejects.toThrow('coupon exhausted');

    const revert = state.log.find((e) =>
      /UPDATE subscription_payment_requests SET status = \$1, reviewed_by = NULL/.test(e.sql));
    expect(revert).toBeTruthy();
    expect(revert.params[0]).toBe(checkout.REQUEST_STATUS.AWAITING_VERIFICATION);
  });

  test('a request not awaiting verification is refused before anything is touched', async () => {
    on(/FROM subscription_payment_requests r JOIN organizations o/, { rows: [aRequest({ status: 'APPROVED' })] });

    await expect(checkout.approve({ requestId: REQ_ID, actor: OPERATOR }))
      .rejects.toMatchObject({ code: 'NOT_AWAITING_VERIFICATION', status: 409 });
    expect(subscription.activate).not.toHaveBeenCalled();
  });

  test('a failure linking the payment row does not undo a successful activation', async () => {
    on(/FROM subscription_payment_requests r JOIN organizations o/, { rows: [submitted()] });
    on(/UPDATE subscription_payment_requests SET status = \$1, reviewed_by = \$2/, { rows: [], rowCount: 1 });
    onThrow(/SELECT id FROM subscription_payments/, new Error('lookup blew up'));
    subscription.activate.mockResolvedValue({ invoice_no: 'INV-3' });

    const res = await checkout.approve({ requestId: REQ_ID, actor: OPERATOR });
    expect(res.request.status).toBe(checkout.REQUEST_STATUS.APPROVED);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  REJECTION
// ════════════════════════════════════════════════════════════════════════════

describe('reject', () => {
  const submitted = () => aRequest({ status: 'AWAITING_VERIFICATION', utr: '123456789012' });

  test('the studio returns to payable with the UTR cleared so it can correct and retry', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.id = \$1 FOR UPDATE/, { rows: [submitted()] });
    on(/UPDATE subscription_payment_requests SET status = \$1, rejected_reason = \$2/,
      { rows: [aRequest({ rejected_note: 'x' })] });

    const out = await checkout.reject({ requestId: REQ_ID, reason: 'WRONG_UTR', actor: OPERATOR });

    expect(out.request.status).toBe(checkout.REQUEST_STATUS.AWAITING_PAYMENT);
    expect(ranSql(/utr = NULL, submitted_at = NULL/)).toBe(true);
  });

  test('the reason reaches the studio as readable text, not just a code', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.id = \$1 FOR UPDATE/, { rows: [submitted()] });
    on(/UPDATE subscription_payment_requests SET status = \$1, rejected_reason = \$2/, { rows: [aRequest()] });

    await checkout.reject({
      requestId: REQ_ID, reason: 'PAYMENT_NOT_RECEIVED', note: 'Nothing in the statement', actor: OPERATOR,
    });

    const p = paramsOf(/UPDATE subscription_payment_requests SET status = \$1, rejected_reason = \$2/);
    expect(p[2]).toContain(checkout.REJECT_REASONS.PAYMENT_NOT_RECEIVED);
    expect(p[2]).toContain('Nothing in the statement');
  });

  test('the expiry window is extended so a late rejection does not land on a dead request', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.id = \$1 FOR UPDATE/, { rows: [submitted()] });
    on(/UPDATE subscription_payment_requests SET status = \$1, rejected_reason = \$2/, { rows: [aRequest()] });

    await checkout.reject({ requestId: REQ_ID, reason: 'WRONG_UTR', actor: OPERATOR });
    expect(ranSql(/expires_at = GREATEST\(expires_at, NOW\(\) \+ interval '60 minutes'\)/)).toBe(true);
  });

  test('an unknown reason code is refused before the row is touched', async () => {
    await expect(checkout.reject({ requestId: REQ_ID, reason: 'BECAUSE_I_SAID_SO', actor: OPERATOR }))
      .rejects.toMatchObject({ code: 'INVALID_REASON', status: 400 });
    expect(ranSql(/UPDATE subscription_payment_requests/)).toBe(false);
  });

  test('a reason inherited from Object.prototype is not accepted', async () => {
    await expect(checkout.reject({ requestId: REQ_ID, reason: 'constructor', actor: OPERATOR }))
      .rejects.toMatchObject({ code: 'INVALID_REASON' });
  });

  test('rejecting something already decided is a 409', async () => {
    on(/FROM subscription_payment_requests r WHERE r\.id = \$1 FOR UPDATE/, { rows: [aRequest({ status: 'APPROVED' })] });
    await expect(checkout.reject({ requestId: REQ_ID, reason: 'WRONG_UTR', actor: OPERATOR }))
      .rejects.toMatchObject({ code: 'NOT_AWAITING_VERIFICATION', status: 409 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  CANCEL + SWEEP
// ════════════════════════════════════════════════════════════════════════════

describe('cancel', () => {
  test('a studio can only cancel its own open request', async () => {
    on(/UPDATE subscription_payment_requests SET status = \$1 WHERE id = \$2 AND organization_id = \$3/,
      { rows: [aRequest({ status: 'CANCELLED' })] });

    await checkout.cancel({ requestId: REQ_ID, orgId: ORG, actor: ACTOR });

    const p = paramsOf(/UPDATE subscription_payment_requests SET status = \$1 WHERE id = \$2 AND organization_id = \$3/);
    expect(p[2]).toBe(ORG);
    expect(p[3]).toEqual(checkout.OPEN_STATUSES);
  });

  test('cancelling an already-decided request is a 409', async () => {
    on(/UPDATE subscription_payment_requests SET status = \$1 WHERE id = \$2 AND organization_id = \$3/, { rows: [] });
    await expect(checkout.cancel({ requestId: REQ_ID, orgId: ORG, actor: ACTOR }))
      .rejects.toMatchObject({ code: 'NOT_CANCELLABLE', status: 409 });
  });
});

describe('expiry sweep', () => {
  test('only unpaid checkouts are swept — never ones waiting on the operator', async () => {
    // A request in AWAITING_VERIFICATION is blocked on the PLATFORM. Expiring
    // it would punish the studio for the operator's own backlog.
    on(/UPDATE subscription_payment_requests SET status = \$1 WHERE status = \$2 AND expires_at < NOW\(\)/,
      { rows: [{ id: 'a' }, { id: 'b' }] });

    const n = await checkout.expireStaleRequests();

    expect(n).toBe(2);
    const p = paramsOf(/UPDATE subscription_payment_requests SET status = \$1 WHERE status = \$2/);
    expect(p[0]).toBe(checkout.REQUEST_STATUS.EXPIRED);
    expect(p[1]).toBe(checkout.REQUEST_STATUS.AWAITING_PAYMENT);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  THE TWO SYSTEMS STAY SEPARATE
// ════════════════════════════════════════════════════════════════════════════

describe('separation from the member→studio system', () => {
  test('this module never touches the member payment tables', async () => {
    on(/FROM platform_payment_settings/, { rows: [SETTINGS] });
    scriptPricing({ amount_due_inr: 2999 });
    on(/FROM subscription_payment_requests r WHERE r\.organization_id = \$1 AND r\.status = ANY/, { rows: [] });
    on(/SELECT nextval/, { rows: [{ n: 5010 }] });
    on(/INSERT INTO subscription_payment_requests/, { rows: [aRequest()] });

    await checkout.openCheckout({ orgId: ORG, planCode: 'pro', actor: ACTOR });

    expect(ranSql(/payment_orders|payment_submissions|upi_settings/i)).toBe(false);
  });
});
