// Founder's Club is for annual subscribers only.
//
// The grant used to be `!alreadyFounder && slots > 0` — any plan qualified
// while a slot was free. The catalogue runs Starter 1 month, Growth 3,
// Professional 6, Elite 12, so ₹1,499 for one month of Starter bought a
// Founder slot AND a price locked for the life of the studio. Twenty slots
// exist; they could all have gone that way.
//
// The rule now compares the term actually granted — opts.periodMonths when a
// super admin sets one, otherwise the plan's own duration — against 12 months.
// Deliberately the term and not the plan code: a 12-month term on any plan is
// a 12-month subscription, and an Elite activation cut short to one month is
// not.
'use strict';

const queries = [];
let mockOrg = { id: 'o1', is_founder: false, locked_price_inr: null, plan_code: null, current_period_end: null };
let mockFounderCount = 0;

const PLANS = {
  starter:      { code: 'starter',      name: 'Starter',      price_inr: 1499, launch_price_inr: null, duration_months: 1,  client_limit: 20 },
  growth:       { code: 'growth',       name: 'Growth',       price_inr: 3999, launch_price_inr: null, duration_months: 3,  client_limit: 25 },
  professional: { code: 'professional', name: 'Professional', price_inr: 6999, launch_price_inr: null, duration_months: 6,  client_limit: 30 },
  elite:        { code: 'elite',        name: 'Elite',        price_inr: 9999, launch_price_inr: 7999, duration_months: 12, client_limit: null },
};

jest.mock('../db/pool', () => {
  const run = async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: q, params });
    if (/count\(\*\)::int AS n FROM founder_members/i.test(q)) return { rows: [{ n: mockFounderCount }] };
    if (/FROM subscription_plans WHERE code/i.test(q)) return { rows: [PLANS[params[0]]].filter(Boolean) };
    if (/FROM organizations WHERE id/i.test(q)) return { rows: [mockOrg] };
    if (/COALESCE\(MAX\(founder_number\),0\)\+1/i.test(q)) return { rows: [{ n: mockFounderCount + 1 }] };
    if (/^INSERT INTO subscription_payments/i.test(q)) return { rows: [{ id: 'pay1' }] };
    if (/^INSERT INTO invoices/i.test(q) || /invoice/i.test(q)) return { rows: [{ id: 'inv1', invoice_number: 'X-1' }] };
    return { rows: [], rowCount: 0 };
  };
  const client = { query: run, release: jest.fn() };
  return { query: run, connect: async () => client };
});

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const subscription = require('../lib/subscription');

/** Did this activation write a founder_members row? */
const grantedFounder = () => queries.some((q) => /^INSERT INTO founder_members/i.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  mockFounderCount = 0;
  mockOrg = { id: 'o1', is_founder: false, locked_price_inr: null, plan_code: null, current_period_end: null };
});

describe('only a 12-month term earns a Founder slot', () => {
  test('Elite (12 months) grants it', async () => {
    await subscription.activate('o1', 'elite', { actor: { id: 'a', name: 'A' } });
    expect(grantedFounder()).toBe(true);
  });

  test.each([
    ['starter', 1],
    ['growth', 3],
    ['professional', 6],
  ])('%s (%i months) does not', async (code) => {
    await subscription.activate('o1', code, { actor: { id: 'a', name: 'A' } });
    expect(grantedFounder()).toBe(false);
  });

  test('a shortened Elite term does not', async () => {
    // A super admin can override the period. Twelve months is the thing being
    // paid for, not the plan's name.
    await subscription.activate('o1', 'elite', { periodMonths: 1, actor: { id: 'a', name: 'A' } });
    expect(grantedFounder()).toBe(false);
  });

  test('a 12-month term on a shorter plan does', async () => {
    // The mirror case, and why this tests the term rather than the plan code.
    await subscription.activate('o1', 'starter', { periodMonths: 12, actor: { id: 'a', name: 'A' } });
    expect(grantedFounder()).toBe(true);
  });

  test('a longer commitment is not refused', async () => {
    await subscription.activate('o1', 'elite', { periodMonths: 24, actor: { id: 'a', name: 'A' } });
    expect(grantedFounder()).toBe(true);
  });
});

describe('the rules that already held', () => {
  test('no slots left means no grant, even on Elite', async () => {
    mockFounderCount = 20;
    await subscription.activate('o1', 'elite', { actor: { id: 'a', name: 'A' } });
    expect(grantedFounder()).toBe(false);
  });

  test('an existing founder is not granted a second slot', async () => {
    mockOrg = { ...mockOrg, is_founder: true, locked_price_inr: 7999 };
    await subscription.activate('o1', 'elite', { actor: { id: 'a', name: 'A' } });
    expect(grantedFounder()).toBe(false);
  });

  test('an existing founder renewing on a SHORT plan keeps their status', async () => {
    // The rule governs who becomes a founder, not who stays one. Stripping a
    // locked price because someone renewed monthly would be a different and
    // much larger decision than the one asked for.
    mockOrg = { ...mockOrg, is_founder: true, locked_price_inr: 7999, plan_code: 'elite' };
    const res = await subscription.activate('o1', 'starter', { actor: { id: 'a', name: 'A' } });
    expect(grantedFounder()).toBe(false);
    expect(res.founder_granted).toBe(false);
    // is_founder is written as (is_founder OR grantFounder) — the OR is what
    // preserves it, and this fails if that ever becomes a plain assignment.
    const upd = queries.find((q) => /UPDATE organizations SET/i.test(q.sql) && /is_founder/i.test(q.sql));
    expect(upd.sql).toMatch(/is_founder\s*=\s*\(is_founder OR/i);
  });
});

describe('what the pricing page is told', () => {
  test('Elite is advertised as founder-eligible while slots remain', async () => {
    const q = await subscription.quote('elite');
    expect(q.founder_eligible).toBe(true);
  });

  test('a one-month plan is not, even with slots free', async () => {
    // The quote drives the pricing page. Promising a founder slot the
    // activation will then refuse is worse than not offering it.
    const q = await subscription.quote('starter');
    expect(q.founder_eligible).toBe(false);
    expect(q.founder_slots_remaining).toBe(20);
  });

  test('Elite is not advertised once the slots are gone', async () => {
    mockFounderCount = 20;
    const q = await subscription.quote('elite');
    expect(q.founder_eligible).toBe(false);
  });

  test('the launch price still tracks slots, not the founder rule', async () => {
    // Launch pricing and founder status are separate offers that happen to
    // share a counter; only Elite carries a launch price at all.
    expect((await subscription.quote('elite')).effective_price_inr).toBe(7999);
    expect((await subscription.quote('starter')).effective_price_inr).toBe(1499);
  });
});
