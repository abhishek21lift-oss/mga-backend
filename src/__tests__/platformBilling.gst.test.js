// GST arithmetic for platform subscription invoices.
//
// Pure-function tests, no database. The failure modes here are arithmetic and
// they are silent: an invoice with the wrong split still looks like an invoice.
'use strict';

const { computeGstSplit, buildInvoiceTax, buyerSnapshot } = require('../lib/platformBilling');

const MH = '27';   // Maharashtra
const KA = '29';   // Karnataka

describe('inclusive pricing', () => {
  it('splits out of the collected amount rather than adding on top', () => {
    // 1180 at 18% inclusive is 1000 + 180. Treating it as exclusive would
    // invoice 1392.40 for a studio that paid 1180.
    const s = computeGstSplit({ amountInr: 1180, gstPercent: 18, pricesIncludeGst: true, sellerStateCode: MH, buyerStateCode: MH });
    expect(s.taxable_value_inr).toBe(1000);
    expect(s.cgst_inr + s.sgst_inr).toBeCloseTo(180, 2);
    expect(s.total_inr).toBe(1180);
  });

  it('adds on top when prices are exclusive', () => {
    const s = computeGstSplit({ amountInr: 1000, gstPercent: 18, pricesIncludeGst: false, sellerStateCode: MH, buyerStateCode: MH });
    expect(s.taxable_value_inr).toBe(1000);
    expect(s.total_inr).toBe(1180);
  });

  it('always has the parts summing back to the collected total', () => {
    // Amounts chosen so the split lands on fractional paise — the case where a
    // naive tax/2 loses a paisa and the invoice stops adding up.
    for (const amount of [999, 1499, 2999, 4999, 7777, 12345]) {
      const s = computeGstSplit({ amountInr: amount, gstPercent: 18, pricesIncludeGst: true, sellerStateCode: MH, buyerStateCode: MH });
      const sum = s.taxable_value_inr + s.cgst_inr + s.sgst_inr + s.igst_inr;
      expect(Math.abs(sum - amount)).toBeLessThanOrEqual(0.01);
    }
  });
});

describe('place of supply', () => {
  it('splits into CGST + SGST within one state', () => {
    const s = computeGstSplit({ amountInr: 1180, gstPercent: 18, pricesIncludeGst: true, sellerStateCode: MH, buyerStateCode: MH });
    expect(s.interstate).toBe(false);
    expect(s.igst_inr).toBe(0);
    expect(s.cgst_inr).toBeCloseTo(90, 2);
    expect(s.sgst_inr).toBeCloseTo(90, 2);
  });

  it('uses a single IGST line across states', () => {
    const s = computeGstSplit({ amountInr: 1180, gstPercent: 18, pricesIncludeGst: true, sellerStateCode: MH, buyerStateCode: KA });
    expect(s.interstate).toBe(true);
    expect(s.igst_inr).toBeCloseTo(180, 2);
    expect(s.cgst_inr).toBe(0);
    expect(s.sgst_inr).toBe(0);
  });

  it('treats an unknown buyer state as intra-state', () => {
    // Never inter-state on a guess: IGST wrongly charged is not creditable to
    // the studio, whereas the intra-state assumption is the correctable one.
    const s = computeGstSplit({ amountInr: 1180, gstPercent: 18, pricesIncludeGst: true, sellerStateCode: MH, buyerStateCode: null });
    expect(s.interstate).toBe(false);
    expect(s.cgst_inr + s.sgst_inr).toBeCloseTo(180, 2);
  });

  it('ignores a leading zero when comparing state codes', () => {
    // '07' and '7' are the same state; comparing them as strings would invoice
    // a Delhi studio IGST from a Delhi seller.
    const s = computeGstSplit({ amountInr: 1180, gstPercent: 18, pricesIncludeGst: true, sellerStateCode: '07', buyerStateCode: '7' });
    expect(s.interstate).toBe(false);
  });
});

describe('zero rate', () => {
  it('produces no tax and a taxable value equal to the amount', () => {
    const s = computeGstSplit({ amountInr: 1000, gstPercent: 0, pricesIncludeGst: true, sellerStateCode: MH, buyerStateCode: MH });
    expect(s.taxable_value_inr).toBe(1000);
    expect(s.cgst_inr).toBe(0);
    expect(s.sgst_inr).toBe(0);
    expect(s.igst_inr).toBe(0);
  });
});

describe('snapshots', () => {
  it('freezes both parties onto the invoice', () => {
    const tax = buildInvoiceTax({
      settings: { legal_name: 'MY PT STUDIO PVT LTD', gstin: '27AAAAA0000A1Z5', state_code: MH, gst_percent: 18, prices_include_gst: true },
      org: { id: 'org-1', name: 'Iron House', billing_name: 'Iron House Fitness LLP', billing_gstin: '27BBBBB1111B1Z9', billing_state_code: MH },
      amountInr: 1180,
    });
    expect(tax.seller_snapshot.gstin).toBe('27AAAAA0000A1Z5');
    expect(tax.buyer_snapshot.name).toBe('Iron House Fitness LLP');
    expect(tax.taxable_value_inr).toBe(1000);
  });

  it('addresses the invoice to the display name when no billing name is set', () => {
    // An invoice made out to nobody is worse than one made out approximately.
    expect(buyerSnapshot({ id: 'o', name: 'Iron House' }).name).toBe('Iron House');
  });
});
