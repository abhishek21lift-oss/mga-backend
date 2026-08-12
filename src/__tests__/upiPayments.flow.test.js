// Flow tests for the manual-UTR payment engine.
//
// These cover the cases that only show up under concurrency or abuse, which
// is exactly where a payment system fails expensively: two admins approving
// at once, a member replaying a UTR, a submission landing on an order that
// has already been closed.
//
// The pool is mocked with a scriptable client so each test can assert the
// SQL guards themselves — that the approval UPDATE really does carry
// `WHERE status = 'VERIFICATION_PENDING'`, for instance. A test that only
// checked the return value would pass against an unguarded UPDATE.
'use strict';

// ── Scriptable pool mock ────────────────────────────────────────────────────
const state = { handlers: [], log: [] };

function makeClient() {
  return {
    query: jest.fn(async (sql, params) => {
      // Patterns are matched against WHITESPACE-FLATTENED sql. The queries in
      // upiPayments.js are template literals broken across lines for
      // readability, so a pattern written on one line would otherwise fail to
      // match for purely cosmetic reasons.
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

jest.mock('../db/receipts', () => ({
  genReceiptNo: jest.fn(async () => 'RCP-20260726-100042'),
}));

const upi = require('../lib/upiPayments');

/** Declare a scripted response. First matching pattern wins. */
function on(match, result) { state.handlers.push({ match, result }); }
function onThrow(match, error) { state.handlers.push({ match, throws: error }); }

/** Every statement issued during the test, normalised to one line. */
function sqlLog() { return state.log.map((e) => e.sql); }
function ranSql(re) { return sqlLog().some((s) => re.test(s)); }

const ORG = '11111111-1111-1111-1111-111111111111';
const ORDER_ID = '22222222-2222-2222-2222-222222222222';
const SUB_ID = '33333333-3333-3333-3333-333333333333';

function anOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    organization_id: ORG,
    order_no: 'UPI-20260726-100001',
    client_id: 'client-1',
    plan_id: 'plan-1',
    plan_name: 'Gold 3 Months',
    duration_months: 3,
    base_amount: '9000.00',
    gst_percent: '18.00',
    gst_amount: '1620.00',
    total_amount: '10620.00',
    upi_id: 'studio@okhdfcbank',
    merchant_name: 'Abhishek PT Studio',
    status: upi.ORDER_STATUS.CREATED,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

const ACTOR = { id: 'usr-admin', name: 'Admin', role: 'admin' };

beforeEach(() => {
  state.handlers = [];
  state.log = [];
  mockCurrentClient = makeClient();
});

// ════════════════════════════════════════════════════════════════════════════
//  DUPLICATE UTR
// ════════════════════════════════════════════════════════════════════════════

describe('duplicate UTR protection', () => {
  test('a UTR already live in this studio is rejected as DUPLICATE_UTR', async () => {
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 FOR UPDATE/s, { rows: [anOrder()] });
    onThrow(/INSERT INTO payment_submissions/s,
      Object.assign(new Error('duplicate key'), {
        code: '23505', constraint: 'uq_payment_submissions_live_utr',
      }));

    await expect(upi.submitUtr({
      order: anOrder(), utr: '123456789012', actor: ACTOR,
    })).rejects.toMatchObject({ code: 'DUPLICATE_UTR', status: 409 });

    // The transaction must not be left open.
    expect(ranSql(/^ROLLBACK$/)).toBe(true);
    expect(ranSql(/^COMMIT$/)).toBe(false);
  });

  test('a second pending submission on the same order is ALREADY_SUBMITTED', async () => {
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 FOR UPDATE/s, { rows: [anOrder()] });
    onThrow(/INSERT INTO payment_submissions/s,
      Object.assign(new Error('duplicate key'), {
        code: '23505', constraint: 'uq_payment_submissions_one_pending',
      }));

    await expect(upi.submitUtr({
      order: anOrder(), utr: '123456789012', actor: ACTOR,
    })).rejects.toMatchObject({ code: 'ALREADY_SUBMITTED', status: 409 });
  });

  test('a non-unique database error is not swallowed as a duplicate', async () => {
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 FOR UPDATE/s, { rows: [anOrder()] });
    onThrow(/INSERT INTO payment_submissions/s,
      Object.assign(new Error('connection reset'), { code: '08006' }));

    await expect(upi.submitUtr({
      order: anOrder(), utr: '123456789012', actor: ACTOR,
    })).rejects.toThrow(/connection reset/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  SUBMISSION GUARDS
// ════════════════════════════════════════════════════════════════════════════

describe('submitting a UTR', () => {
  test('succeeds against an open order and moves it to VERIFICATION_PENDING', async () => {
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 FOR UPDATE/s, { rows: [anOrder()] });
    on(/INSERT INTO payment_submissions/s, {
      rows: [{ id: SUB_ID, utr: '123456789012', status: 'VERIFICATION_PENDING' }],
    });

    const sub = await upi.submitUtr({
      order: anOrder(), utr: '123456789012', actor: ACTOR,
    });

    expect(sub.utr).toBe('123456789012');
    expect(ranSql(/UPDATE payment_orders SET status = \$1 WHERE id = \$2 AND status = ANY/)).toBe(true);
    expect(ranSql(/INSERT INTO payment_audit_logs/)).toBe(true);
    expect(ranSql(/^COMMIT$/)).toBe(true);
  });

  test('is refused once the order has been approved', async () => {
    const approved = anOrder({ status: upi.ORDER_STATUS.APPROVED });
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 FOR UPDATE/s, { rows: [approved] });

    await expect(upi.submitUtr({ order: approved, utr: '123456789012', actor: ACTOR }))
      .rejects.toMatchObject({ code: 'ORDER_NOT_OPEN', status: 409 });
    expect(ranSql(/INSERT INTO payment_submissions/)).toBe(false);
  });

  test('is refused once the order has expired', async () => {
    const stale = anOrder({ expires_at: new Date(Date.now() - 1000).toISOString() });
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 FOR UPDATE/s, { rows: [stale] });

    await expect(upi.submitUtr({ order: stale, utr: '123456789012', actor: ACTOR }))
      .rejects.toMatchObject({ code: 'ORDER_EXPIRED', status: 409 });
  });

  test('404s when the order vanished between load and lock', async () => {
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 FOR UPDATE/s, { rows: [] });
    await expect(upi.submitUtr({ order: anOrder(), utr: '123456789012', actor: ACTOR }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  APPROVAL
// ════════════════════════════════════════════════════════════════════════════

function scriptHappyApproval() {
  on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 AND o\.organization_id = \$2 FOR UPDATE/s,
    { rows: [anOrder({ status: upi.ORDER_STATUS.VERIFICATION_PENDING })] });
  on(/SELECT \* FROM payment_submissions WHERE payment_order_id = \$1 AND status = \$2/s,
    { rows: [{ id: SUB_ID, utr: '123456789012', submitted_at: '2026-07-26T10:00:00Z' }] });
  on(/UPDATE payment_orders SET status = \$1 WHERE id = \$2 AND status = \$3/s,
    { rows: [], rowCount: 1 });
  on(/SELECT id, name, email, mobile, trainer_id, pt_end_date, organization_id FROM pt_clients/s,
    { rows: [{ id: 'client-1', name: 'Rohit', trainer_id: 'trn-1', pt_end_date: '2026-09-01' }] });
  on(/SELECT id, incentive_rate FROM trainers/s, { rows: [{ id: 'trn-1', incentive_rate: 0.5 }] });
  on(/INSERT INTO membership_payments/s, {
    rows: [{ id: 'mp-1', receipt_no: 'RCP-20260726-100042', activated_from: '2026-09-01',
             activated_to: '2026-12-01', amount: '10620.00' }],
  });
}

describe('approval', () => {
  test('activates the membership, writes the ledger row and stamps a receipt', async () => {
    scriptHappyApproval();

    const result = await upi.approve({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR });

    expect(result.order.status).toBe(upi.ORDER_STATUS.APPROVED);
    expect(result.activation.receipt_no).toBe('RCP-20260726-100042');
    expect(ranSql(/^COMMIT$/)).toBe(true);
  });

  test('records UPI revenue in the shared finance ledger, not a private table', async () => {
    // This is why the revenue dashboard and the monthly target pick these
    // payments up without any special-casing.
    scriptHappyApproval();
    await upi.approve({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR });

    const ledger = state.log.find((e) => /INSERT INTO pt_payments/.test(e.sql));
    expect(ledger).toBeDefined();
    expect(ledger.sql).toMatch(/'UPI'/);
    expect(ledger.params).toContain(ORG);
  });

  test('extends an unexpired membership rather than restarting it', async () => {
    scriptHappyApproval(); // existing pt_end_date is 2026-09-01, three months bought
    await upi.approve({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR });

    const update = state.log.find((e) => /UPDATE pt_clients/.test(e.sql));
    expect(update.params[0]).toBe('2026-09-01');   // activated_from
    expect(update.params[1]).toBe('2026-12-01');   // activated_to
  });

  test('guards the status transition so a double approve cannot double-activate', async () => {
    scriptHappyApproval();
    await upi.approve({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR });

    const transition = state.log.find(
      (e) => /UPDATE payment_orders SET status = \$1 WHERE id = \$2 AND status = \$3/.test(e.sql)
    );
    expect(transition).toBeDefined();
    expect(transition.params[0]).toBe(upi.ORDER_STATUS.APPROVED);
    expect(transition.params[2]).toBe(upi.ORDER_STATUS.VERIFICATION_PENDING);
  });

  test('409s when the guarded transition matches no rows (someone else won the race)', async () => {
    scriptHappyApproval();
    state.handlers = state.handlers.filter(
      (h) => !/UPDATE payment_orders SET status = \\\$1 WHERE id/.test(h.match.source)
    );
    on(/UPDATE payment_orders SET status = \$1 WHERE id = \$2 AND status = \$3/s,
      { rows: [], rowCount: 0 });

    await expect(upi.approve({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR }))
      .rejects.toMatchObject({ code: 'CONCURRENT_UPDATE', status: 409 });
    expect(ranSql(/^ROLLBACK$/)).toBe(true);
    expect(ranSql(/INSERT INTO membership_payments/)).toBe(false);
  });

  test('409s when the activation row already exists (the belt to the braces)', async () => {
    scriptHappyApproval();
    state.handlers = state.handlers.filter(
      (h) => !/INSERT INTO membership_payments/.test(h.match.source)
    );
    onThrow(/INSERT INTO membership_payments/s,
      Object.assign(new Error('duplicate key'), {
        code: '23505', constraint: 'membership_payments_order_unique',
      }));

    await expect(upi.approve({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR }))
      .rejects.toMatchObject({ code: 'ALREADY_ACTIVATED', status: 409 });
    expect(ranSql(/^ROLLBACK$/)).toBe(true);
  });

  test('writes an invoice so the sale appears on /finance/invoices', async () => {
    scriptHappyApproval();
    await upi.approve({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR });

    const invoice = state.log.find((e) => /INSERT INTO invoices/.test(e.sql));
    expect(invoice).toBeDefined();
    // Numbered off the order sequence, not Date.now() — the latter collides
    // under concurrency, which is the bug src/db/receipts.js exists to avoid.
    expect(invoice.params[1]).toBe('INV-20260726-100001');
    expect(invoice.sql).toMatch(/'paid'/);
  });

  test('a failing invoice insert does not strand a member who has paid', async () => {
    scriptHappyApproval();
    onThrow(/INSERT INTO invoices/s, Object.assign(new Error('relation does not exist'), {
      code: '42P01',
    }));

    await expect(upi.approve({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR })).resolves.toBeDefined();

    // A SAVEPOINT is what makes this survivable: in Postgres a failed statement
    // aborts the whole transaction, so a bare try/catch would leave every
    // following statement failing with "current transaction is aborted".
    expect(ranSql(/^SAVEPOINT upi_invoice$/)).toBe(true);
    expect(ranSql(/^ROLLBACK TO SAVEPOINT upi_invoice$/)).toBe(true);
    expect(ranSql(/INSERT INTO membership_payments/)).toBe(true);
    expect(ranSql(/^COMMIT$/)).toBe(true);
  });

  test('refuses an order that is not awaiting verification', async () => {
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 AND o\.organization_id = \$2 FOR UPDATE/s,
      { rows: [anOrder({ status: upi.ORDER_STATUS.CREATED })] });

    await expect(upi.approve({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR }))
      .rejects.toMatchObject({ code: 'NOT_PENDING_VERIFICATION', status: 409 });
  });

  test('refuses when there is no pending submission to approve', async () => {
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 AND o\.organization_id = \$2 FOR UPDATE/s,
      { rows: [anOrder({ status: upi.ORDER_STATUS.VERIFICATION_PENDING })] });
    on(/SELECT \* FROM payment_submissions WHERE payment_order_id = \$1 AND status = \$2/s,
      { rows: [] });

    await expect(upi.approve({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR }))
      .rejects.toMatchObject({ code: 'NO_SUBMISSION', status: 409 });
  });

  test('is scoped to the caller\'s organization', async () => {
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 AND o\.organization_id = \$2 FOR UPDATE/s,
      { rows: [] });

    await expect(upi.approve({ orderId: ORDER_ID, orgId: 'other-org', actor: ACTOR }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    const load = state.log.find((e) => /FROM payment_orders o WHERE o.id/.test(e.sql));
    expect(load.params).toEqual([ORDER_ID, 'other-org']);
  });

  test('survives a client whose trainer has been deleted', async () => {
    // A dangling trainer_id would otherwise abort the whole approval with a
    // foreign-key violation on the ledger insert.
    scriptHappyApproval();
    state.handlers = state.handlers.filter(
      (h) => !/SELECT id, incentive_rate FROM trainers/.test(h.match.source)
    );
    on(/SELECT id, incentive_rate FROM trainers/s, { rows: [] });

    await upi.approve({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR });
    const ledger = state.log.find((e) => /INSERT INTO pt_payments/.test(e.sql));
    expect(ledger.params[2]).toBeNull(); // trainer_id
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  REJECTION
// ════════════════════════════════════════════════════════════════════════════

describe('rejection', () => {
  function scriptReject(rowCount = 1) {
    on(/SELECT .* FROM payment_orders o WHERE o\.id = \$1 AND o\.organization_id = \$2 FOR UPDATE/s,
      { rows: [anOrder({ status: upi.ORDER_STATUS.VERIFICATION_PENDING })] });
    on(/UPDATE payment_submissions SET status = \$1, rejected_reason/s, { rows: [], rowCount });
  }

  test('returns the ORDER to PAYMENT_PENDING so the member can resubmit', async () => {
    scriptReject();
    const result = await upi.reject({
      orderId: ORDER_ID, orgId: ORG, reason: 'WRONG_UTR', note: 'Check the number', actor: ACTOR,
    });

    expect(result.order.status).toBe(upi.ORDER_STATUS.PAYMENT_PENDING);
    const orderUpdate = state.log.find((e) => /UPDATE payment_orders SET status = \$1, expires_at/.test(e.sql));
    expect(orderUpdate.params[0]).toBe(upi.ORDER_STATUS.PAYMENT_PENDING);
    expect(ranSql(/^COMMIT$/)).toBe(true);
  });

  test('marks only the SUBMISSION rejected, with its reason', async () => {
    scriptReject();
    await upi.reject({ orderId: ORDER_ID, orgId: ORG, reason: 'AMOUNT_MISMATCH', actor: ACTOR });

    const subUpdate = state.log.find((e) => /UPDATE payment_submissions SET status/.test(e.sql));
    expect(subUpdate.params[0]).toBe(upi.SUBMISSION_STATUS.REJECTED);
    expect(subUpdate.params[1]).toBe('AMOUNT_MISMATCH');
  });

  test('refuses a reason the domain does not define', async () => {
    await expect(upi.reject({
      orderId: ORDER_ID, orgId: ORG, reason: 'BECAUSE_I_SAID_SO', actor: ACTOR,
    })).rejects.toMatchObject({ code: 'INVALID_REASON', status: 400 });
  });

  test('refuses to reject an order nobody has submitted against', async () => {
    scriptReject(0);
    await expect(upi.reject({
      orderId: ORDER_ID, orgId: ORG, reason: 'WRONG_UTR', actor: ACTOR,
    })).rejects.toMatchObject({ code: 'NO_SUBMISSION', status: 409 });
    expect(ranSql(/^ROLLBACK$/)).toBe(true);
  });

  test('records a correction request under its own audit action', async () => {
    scriptReject();
    await upi.reject({
      orderId: ORDER_ID, orgId: ORG, reason: 'OTHER', note: 'Send a clearer screenshot',
      actor: ACTOR, correction: true,
    });
    const auditRow = state.log.find((e) => /INSERT INTO payment_audit_logs/.test(e.sql));
    expect(auditRow.params).toContain('CORRECTION_REQUESTED');
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  CANCELLATION + EXPIRY
// ════════════════════════════════════════════════════════════════════════════

describe('cancellation', () => {
  test('cancels an open order and voids its pending submission', async () => {
    on(/UPDATE payment_orders SET status = \$1 WHERE id = \$2 AND organization_id = \$3/s,
      { rows: [anOrder({ status: upi.ORDER_STATUS.CANCELLED })] });

    await upi.cancel({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR });
    expect(ranSql(/UPDATE payment_submissions SET status = \$1 WHERE payment_order_id/)).toBe(true);
    expect(ranSql(/^COMMIT$/)).toBe(true);
  });

  test('refuses to cancel an order that has already been approved', async () => {
    on(/UPDATE payment_orders SET status = \$1 WHERE id = \$2 AND organization_id = \$3/s,
      { rows: [] });
    await expect(upi.cancel({ orderId: ORDER_ID, orgId: ORG, actor: ACTOR }))
      .rejects.toMatchObject({ code: 'NOT_CANCELLABLE', status: 409 });
  });
});

describe('expiry sweep', () => {
  test('only touches orders that are still waiting on the MEMBER', async () => {
    on(/UPDATE payment_orders SET status = \$1 WHERE status = ANY/s, { rows: [] });
    await upi.expireStaleOrders();

    const sweep = state.log.find((e) => /UPDATE payment_orders SET status = \$1 WHERE status = ANY/.test(e.sql));
    expect(sweep.params[0]).toBe(upi.ORDER_STATUS.EXPIRED);
    expect(sweep.params[1]).toEqual([
      upi.ORDER_STATUS.CREATED, upi.ORDER_STATUS.PAYMENT_PENDING,
    ]);
    expect(sweep.params[1]).not.toContain(upi.ORDER_STATUS.VERIFICATION_PENDING);
  });

  test('audits each order it closes', async () => {
    on(/UPDATE payment_orders SET status = \$1 WHERE status = ANY/s, {
      rows: [{ id: ORDER_ID, organization_id: ORG, status: 'EXPIRED' }],
    });
    const count = await upi.expireStaleOrders();
    expect(count).toBe(1);
    expect(ranSql(/INSERT INTO payment_audit_logs/)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════════════════════════════════

describe('settings gate', () => {
  test('an unconfigured studio cannot take payments', async () => {
    on(/SELECT .* FROM payment_settings WHERE organization_id/s, { rows: [] });
    await expect(upi.requireActiveSettings(ORG))
      .rejects.toMatchObject({ code: 'PAYMENTS_NOT_CONFIGURED', status: 409 });
  });

  test('a studio that switched collection off cannot take payments', async () => {
    on(/SELECT .* FROM payment_settings WHERE organization_id/s, {
      rows: [{ upi_id: 'studio@ybl', is_enabled: false }],
    });
    await expect(upi.requireActiveSettings(ORG))
      .rejects.toMatchObject({ code: 'PAYMENTS_DISABLED', status: 409 });
  });

  test('a stored VPA that has since become malformed still fails closed', async () => {
    on(/SELECT .* FROM payment_settings WHERE organization_id/s, {
      rows: [{ upi_id: 'not-a-vpa', is_enabled: true }],
    });
    await expect(upi.requireActiveSettings(ORG))
      .rejects.toMatchObject({ code: 'INVALID_VPA' });
  });

  test('an enabled, well-formed studio passes', async () => {
    on(/SELECT .* FROM payment_settings WHERE organization_id/s, {
      rows: [{ upi_id: 'studio@okhdfcbank', is_enabled: true, gst_percent: '18.00' }],
    });
    await expect(upi.requireActiveSettings(ORG)).resolves.toMatchObject({ is_enabled: true });
  });

  test('upsert refuses a malformed VPA before it reaches the database', async () => {
    await expect(upi.upsertSettings(ORG, { upi_id: 'nope', merchant_name: 'X' }))
      .rejects.toMatchObject({ code: 'INVALID_VPA' });
    expect(ranSql(/INSERT INTO payment_settings/)).toBe(false);
  });
});
