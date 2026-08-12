// Unit tests for the pure parts of the manual-UTR payment domain.
//
// These are the calculations a wrong answer in which produces a QR code
// asking for the wrong amount, or a membership that ends on the wrong day —
// both of which are invisible until a member complains.
'use strict';

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

const upi = require('../lib/upiPayments');

describe('computeTotals', () => {
  test('adds GST on top of the base amount', () => {
    expect(upi.computeTotals(1000, 18)).toEqual({
      base_amount: 1000, gst_percent: 18, gst_amount: 180, total_amount: 1180,
    });
  });

  test('rounds to paise rather than carrying float error', () => {
    // 18% of 2999 is 539.8199999999999 in IEEE-754. Stored unrounded, the
    // receipt would not add up.
    const t = upi.computeTotals(2999, 18);
    expect(t.gst_amount).toBe(539.82);
    expect(t.total_amount).toBe(3538.82);
    expect(upi.round2(t.base_amount + t.gst_amount)).toBe(t.total_amount);
  });

  test('omits GST entirely when the rate is zero', () => {
    expect(upi.computeTotals(500, 0)).toEqual({
      base_amount: 500, gst_percent: 0, gst_amount: 0, total_amount: 500,
    });
  });

  test('rejects a zero total — a zero-rupee UPI intent is refused by every app', () => {
    expect(() => upi.computeTotals(0, 18)).toThrow(/greater than zero/i);
  });

  test('rejects a negative base amount', () => {
    expect(() => upi.computeTotals(-100, 0)).toThrow(upi.PaymentError);
  });
});

describe('VPA validation', () => {
  test.each([
    'studio@okhdfcbank',
    'my.pt-studio@ybl',
    'abc_123@paytm',
  ])('accepts %s', (vpa) => {
    expect(() => upi.assertVpa(vpa)).not.toThrow();
  });

  test.each([
    ['no at sign', 'studiookhdfcbank'],
    ['empty handle', '@ybl'],
    ['handle starting with a digit', 'studio@1bank'],
    ['spaces', 'my studio@ybl'],
    ['injection attempt', 'studio@ybl&am=1'],
    ['empty', ''],
    ['undefined', undefined],
  ])('rejects %s', (_label, vpa) => {
    expect(() => upi.assertVpa(vpa)).toThrow(upi.PaymentError);
  });
});

describe('buildUpiIntent', () => {
  const base = {
    upiId: 'studio@okhdfcbank',
    merchantName: 'Abhishek PT Studio',
    amount: 1180,
    orderNo: 'UPI-20260726-100001',
  };

  test('produces a upi://pay link with the NPCI parameters', () => {
    const url = upi.buildUpiIntent(base);
    const params = new URLSearchParams(url.slice('upi://pay?'.length));
    expect(url.startsWith('upi://pay?')).toBe(true);
    expect(params.get('pa')).toBe('studio@okhdfcbank');
    expect(params.get('cu')).toBe('INR');
    expect(params.get('am')).toBe('1180.00');
  });

  test('always sends the amount with two decimals', () => {
    const url = upi.buildUpiIntent({ ...base, amount: 1500 });
    expect(new URLSearchParams(url.split('?')[1]).get('am')).toBe('1500.00');
  });

  test('strips hyphens from the transaction reference', () => {
    // Several PSP apps drop the whole intent when `tr` contains a hyphen.
    const url = upi.buildUpiIntent(base);
    expect(new URLSearchParams(url.split('?')[1]).get('tr')).toBe('UPI20260726100001');
  });

  test('caps the transaction reference at NPCI\'s 35 characters', () => {
    expect(upi.toTxnRef('X'.repeat(80))).toHaveLength(35);
  });

  test('strips query-terminating characters from the note', () => {
    // A stray & or # turns a valid intent into a silently failing one.
    expect(upi.toTxnNote('Gold & Platinum #1')).toBe('Gold Platinum 1');
  });

  test('refuses to build an intent for a zero amount', () => {
    expect(() => upi.buildUpiIntent({ ...base, amount: 0 })).toThrow(upi.PaymentError);
  });

  test('refuses to build an intent for an invalid VPA', () => {
    expect(() => upi.buildUpiIntent({ ...base, upiId: 'nope' })).toThrow(upi.PaymentError);
  });
});

describe('buildAppIntents', () => {
  test('carries the identical query string onto every app scheme', () => {
    const intent = upi.buildUpiIntent({
      upiId: 'studio@ybl', merchantName: 'Studio', amount: 100, orderNo: 'UPI-1',
    });
    const query = intent.slice(intent.indexOf('?'));
    const apps = upi.buildAppIntents(intent);
    expect(apps).toHaveLength(upi.UPI_APPS.length);
    for (const app of apps) {
      expect(app.url.endsWith(query)).toBe(true);
    }
  });
});

describe('computeMembershipWindow', () => {
  test('starts today when there is no existing membership', () => {
    const w = upi.computeMembershipWindow(null, 3, '2026-07-26');
    expect(w).toEqual({ activated_from: '2026-07-26', activated_to: '2026-10-26' });
  });

  test('EXTENDS an unexpired membership instead of restarting it', () => {
    // Renewing early must not cost the member the days they had left.
    const w = upi.computeMembershipWindow('2026-09-01', 1, '2026-07-26');
    expect(w.activated_from).toBe('2026-09-01');
    expect(w.activated_to).toBe('2026-10-01');
  });

  test('starts today when the existing membership has already lapsed', () => {
    const w = upi.computeMembershipWindow('2026-01-01', 1, '2026-07-26');
    expect(w.activated_from).toBe('2026-07-26');
  });

  test('clamps a month-end start date instead of overflowing the month', () => {
    // 31 Jan + 1 month is 28 Feb, not 3 March the way setMonth() would give.
    const w = upi.computeMembershipWindow(null, 1, '2026-01-31');
    expect(w.activated_to).toBe('2026-02-28');
  });

  test('handles a leap year at the month end', () => {
    const w = upi.computeMembershipWindow(null, 1, '2028-01-31');
    expect(w.activated_to).toBe('2028-02-29');
  });

  test('treats an unparseable legacy pt_end_date as no membership', () => {
    // pt_clients.pt_end_date is TEXT and old imported rows hold junk. Casting
    // that in SQL would abort the whole approval transaction.
    for (const junk of ['', '  ', 'N/A', '26/07/2026', null, undefined, 12345]) {
      expect(upi.computeMembershipWindow(junk, 1, '2026-07-26').activated_from)
        .toBe('2026-07-26');
    }
  });

  test('the window always ends after it begins', () => {
    const w = upi.computeMembershipWindow(null, 1, '2026-07-26');
    expect(w.activated_to > w.activated_from).toBe(true);
  });
});

describe('status vocabulary', () => {
  test('an order awaiting verification is not sweepable by the expiry job', () => {
    // Expiring it would punish the member for the studio's backlog.
    expect(upi.OPEN_ORDER_STATUSES).not.toContain(upi.ORDER_STATUS.VERIFICATION_PENDING);
    expect(upi.OPEN_ORDER_STATUSES).toEqual([
      upi.ORDER_STATUS.CREATED, upi.ORDER_STATUS.PAYMENT_PENDING,
    ]);
  });

  test('every rejection reason the API accepts has a member-facing message', () => {
    const apiReasons = ['DUPLICATE_UTR', 'WRONG_UTR', 'PAYMENT_NOT_RECEIVED',
                        'AMOUNT_MISMATCH', 'FAKE_SCREENSHOT', 'OTHER'];
    expect(Object.keys(upi.REJECT_REASONS).sort()).toEqual(apiReasons.sort());
    for (const r of apiReasons) {
      expect(typeof upi.REJECT_REASONS[r]).toBe('string');
      expect(upi.REJECT_REASONS[r].length).toBeGreaterThan(0);
    }
  });
});

describe('generateQrDataUrl', () => {
  test('encodes the intent as a PNG data URI', async () => {
    const intent = upi.buildUpiIntent({
      upiId: 'studio@ybl', merchantName: 'Studio', amount: 250, orderNo: 'UPI-2',
    });
    const dataUrl = await upi.generateQrDataUrl(intent);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(500);
  });
});
