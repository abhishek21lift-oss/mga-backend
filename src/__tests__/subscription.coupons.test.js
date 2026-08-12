'use strict';
// Coupon discount maths.
//
// This sets what a studio is actually charged, so the edges matter: a discount
// larger than the order would invert the charge, and an uncapped percentage on
// a big plan gives away more than intended.
//
// Only the pure helper is exercised here — validateCoupon/redeemCoupon need a
// database and are covered by the route tests.

const { computeDiscount } = require('../lib/subscription');

const percent = (v, extra = {}) => ({ discount_type: 'percent', discount_value: v, max_discount_inr: null, ...extra });
const fixed = (v, extra = {}) => ({ discount_type: 'fixed', discount_value: v, max_discount_inr: null, ...extra });

describe('computeDiscount — percentage', () => {
  test('takes the stated percentage off', () => {
    expect(computeDiscount(percent(20), 1499)).toBe(300); // 299.8 → 300
    expect(computeDiscount(percent(50), 4000)).toBe(2000);
  });

  test('100% clears the whole charge but never goes below zero', () => {
    expect(computeDiscount(percent(100), 6999)).toBe(6999);
  });

  test('respects an absolute cap', () => {
    // 50% of 9,999 is 4,999.50, capped at 2,000.
    expect(computeDiscount(percent(50, { max_discount_inr: 2000 }), 9999)).toBe(2000);
  });

  test('cap only binds when it is actually lower', () => {
    expect(computeDiscount(percent(10, { max_discount_inr: 5000 }), 1499)).toBe(150);
  });
});

describe('computeDiscount — fixed amount', () => {
  // Returns the DISCOUNT, not the net — ₹500 off ₹1,499 leaves ₹999 due.
  test('takes a flat amount off', () => {
    expect(computeDiscount(fixed(500), 1499)).toBe(500);
  });

  test('is clamped to the order value — a coupon never creates a credit', () => {
    expect(computeDiscount(fixed(5000), 1499)).toBe(1499);
  });

  test('exactly covering the order leaves zero due', () => {
    expect(computeDiscount(fixed(1499), 1499)).toBe(1499);
  });
});

describe('computeDiscount — degenerate input', () => {
  test('a zero or negative order yields no discount', () => {
    expect(computeDiscount(percent(50), 0)).toBe(0);
    expect(computeDiscount(fixed(500), 0)).toBe(0);
    expect(computeDiscount(percent(50), -100)).toBe(0);
  });

  test('a missing coupon yields no discount', () => {
    expect(computeDiscount(null, 1499)).toBe(0);
    expect(computeDiscount(undefined, 1499)).toBe(0);
  });

  test('a missing or non-numeric amount yields no discount', () => {
    expect(computeDiscount(percent(50), null)).toBe(0);
    expect(computeDiscount(percent(50), undefined)).toBe(0);
    expect(computeDiscount(percent(50), 'abc')).toBe(0);
  });

  test('always returns whole rupees', () => {
    for (const amount of [1499, 3999, 6999, 9999, 7999]) {
      expect(Number.isInteger(computeDiscount(percent(33), amount))).toBe(true);
    }
  });

  test('never exceeds the gross for any percentage', () => {
    for (const pct of [1, 25, 50, 99, 100]) {
      const d = computeDiscount(percent(pct), 3999);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(3999);
    }
  });
});

describe('computeDiscount — real plan prices', () => {
  // A launch-offer style promo across the catalogue.
  test.each([
    ['starter', 1499, 300],
    ['growth', 3999, 800],
    ['professional', 6999, 1400],
    ['elite', 7999, 1600],
  ])('20%% off %s (₹%i) → ₹%i', (_plan, price, expected) => {
    expect(computeDiscount(percent(20), price)).toBe(expected);
  });
});
