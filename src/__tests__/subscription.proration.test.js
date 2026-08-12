'use strict';
// Proration maths for plan upgrades.
//
// This decides what a studio is actually charged when it switches plans, so the
// edge cases matter more than the happy path: a credit that is too generous
// gives away revenue, one that is too small overcharges a paying customer.
//
// Only the pure helpers are exercised here — quotePlanChange/changePlan need a
// live database and are covered separately.

const subscription = require('../lib/subscription');

const { prorationCredit } = subscription;

// Fixed clock so "half way through the period" is exact rather than approximate.
const START = new Date('2026-01-01T00:00:00Z');
const END = new Date('2026-02-01T00:00:00Z'); // 31-day period
const org = { current_period_start: START, current_period_end: END };

describe('prorationCredit', () => {
  test('credits the full amount when the period has not started being consumed', () => {
    expect(prorationCredit(org, 1499, START)).toBe(1499);
  });

  test('credits nothing once the period has ended', () => {
    expect(prorationCredit(org, 1499, END)).toBe(0);
    expect(prorationCredit(org, 1499, new Date('2026-03-01T00:00:00Z'))).toBe(0);
  });

  test('credits half way through the period', () => {
    // 31-day period → midpoint is 15.5 days in.
    const mid = new Date('2026-01-16T12:00:00Z');
    expect(prorationCredit(org, 1000, mid)).toBe(500);
  });

  test('credit shrinks as the period is consumed', () => {
    const quarter = prorationCredit(org, 4000, new Date('2026-01-08T18:00:00Z'));
    const half = prorationCredit(org, 4000, new Date('2026-01-16T12:00:00Z'));
    const threeQuarters = prorationCredit(org, 4000, new Date('2026-01-24T06:00:00Z'));
    expect(quarter).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(threeQuarters);
    expect(threeQuarters).toBeGreaterThan(0);
  });

  test('never exceeds what was actually paid', () => {
    // A clock skewed before the period start must not inflate the credit.
    const before = new Date('2025-12-01T00:00:00Z');
    expect(prorationCredit(org, 1499, before)).toBeLessThanOrEqual(1499);
  });

  test('returns 0 when there is no billing period (trial / never subscribed)', () => {
    expect(prorationCredit({}, 1499, START)).toBe(0);
    expect(prorationCredit(null, 1499, START)).toBe(0);
    expect(prorationCredit({ current_period_start: START }, 1499, START)).toBe(0);
  });

  test('returns 0 for a zero-length or inverted period rather than dividing by zero', () => {
    const zero = { current_period_start: START, current_period_end: START };
    expect(prorationCredit(zero, 1499, START)).toBe(0);
    const inverted = { current_period_start: END, current_period_end: START };
    expect(Number.isFinite(prorationCredit(inverted, 1499, START))).toBe(true);
  });

  test('handles a zero or missing payment amount', () => {
    expect(prorationCredit(org, 0, START)).toBe(0);
    expect(prorationCredit(org, null, START)).toBe(0);
    expect(prorationCredit(org, undefined, START)).toBe(0);
  });

  test('returns whole rupees, never fractions', () => {
    const credit = prorationCredit(org, 1499, new Date('2026-01-09T07:13:00Z'));
    expect(Number.isInteger(credit)).toBe(true);
  });
});

describe('effectivePrice — launch offer gating', () => {
  const elite = { code: 'elite', price_inr: 9999, launch_price_inr: 7999, duration_months: 12 };
  const starter = { code: 'starter', price_inr: 1499, launch_price_inr: null, duration_months: 1 };

  test('applies the launch price while founder slots remain', () => {
    expect(subscription.effectivePrice(elite, 5)).toEqual({ amount: 7999, isLaunch: true });
  });

  test('reverts to list price once founder slots are gone', () => {
    expect(subscription.effectivePrice(elite, 0)).toEqual({ amount: 9999, isLaunch: false });
  });

  test('plans without a launch price are unaffected by remaining slots', () => {
    expect(subscription.effectivePrice(starter, 20)).toEqual({ amount: 1499, isLaunch: false });
    expect(subscription.effectivePrice(starter, 0)).toEqual({ amount: 1499, isLaunch: false });
  });
});

describe('Founder Club cap', () => {
  test('is 20 per the product spec', () => {
    expect(subscription.FOUNDER_LIMIT).toBe(20);
  });
});
