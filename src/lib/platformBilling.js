// src/lib/platformBilling.js
//
// The platform's own billing identity and the GST arithmetic for subscription
// invoices — MY PT STUDIO invoicing a studio, which is the opposite direction
// to upiPayments.js (a member paying a studio).
//
// The one rule this module exists to enforce: TAX IS SNAPSHOTTED, NEVER
// RECOMPUTED. Every function here is called once, at issue time, and its
// output is written onto the invoice row. Nothing downstream — not the PDF,
// not the CSV export, not the list view — recalculates. If it did, changing
// the platform's GST rate would silently rewrite every historical invoice and
// stop them matching the returns already filed against them.
'use strict';

// Used when the settings row is missing (a database that predates migration
// 122, or a test with a bare mock). 18% inclusive reproduces exactly what the
// platform charges today, so falling back here never changes a number.
const DEFAULTS = {
  gst_percent: 18,
  prices_include_gst: true,
  invoice_prefix: 'MPT',
  country: 'India',
};

/**
 * Load the singleton settings row.
 *
 * The pool is required lazily rather than at module load: db/pool.js exits the
 * process when DATABASE_URL is unset, and the arithmetic below is pure and
 * must stay callable — and testable — without a database anywhere near it.
 *
 * @param {object} [client] a pg client inside a transaction; defaults to the pool.
 */
async function loadSettings(client) {
  const db = client || require('../db/pool');
  const { rows } = await db.query('SELECT * FROM platform_billing_settings WHERE id = TRUE');
  return { ...DEFAULTS, ...(rows[0] || {}) };
}

/** Round to paise. Money must never carry float noise into a document. */
function money(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Split a collected amount into taxable value and GST.
 *
 * Intra-state supply (seller and buyer in the same state) splits into CGST +
 * SGST; inter-state is a single IGST line. When the buyer's state is unknown
 * the supply is treated as intra-state — the conservative choice, because
 * that is what an un-onboarded studio in the platform's home state looks
 * like, and the operator can correct the studio's state code and reissue.
 *
 * @param {object} args
 * @param {number} args.amountInr        what was actually collected (gross)
 * @param {number} args.gstPercent
 * @param {boolean} args.pricesIncludeGst  true → split the amount; false → tax on top
 * @param {string|null} args.sellerStateCode
 * @param {string|null} args.buyerStateCode
 * @returns {{taxable_value_inr:number, gst_percent:number, cgst_inr:number,
 *            sgst_inr:number, igst_inr:number, total_inr:number, interstate:boolean}}
 */
function computeGstSplit({
  amountInr, gstPercent, pricesIncludeGst = true, sellerStateCode, buyerStateCode,
}) {
  const gross = Number(amountInr) || 0;
  const rate = Number(gstPercent) || 0;

  // Inclusive: 118 at 18% is 100 + 18, not 118 + 21.24. Getting this backwards
  // is the classic GST bug and it overstates revenue by the tax on the tax.
  const taxable = pricesIncludeGst ? gross / (1 + rate / 100) : gross;
  const tax = pricesIncludeGst ? gross - taxable : gross * (rate / 100);

  const sState = norm(sellerStateCode);
  const bState = norm(buyerStateCode);
  const interstate = Boolean(sState && bState && sState !== bState);

  // The halves are derived from each other rather than both from tax/2, so an
  // odd number of paise lands somewhere instead of vanishing: the parts always
  // sum back to the whole.
  const cgst = interstate ? 0 : money(tax / 2);
  const sgst = interstate ? 0 : money(tax - cgst);
  const igst = interstate ? money(tax) : 0;

  return {
    taxable_value_inr: money(taxable),
    gst_percent: rate,
    cgst_inr: cgst,
    sgst_inr: sgst,
    igst_inr: igst,
    total_inr: money(pricesIncludeGst ? gross : taxable + tax),
    interstate,
  };
}

function norm(v) {
  return v == null ? null : String(v).trim().replace(/^0+(?=\d)/, '') || null;
}

/** Frozen copy of the seller as it stood when the invoice was issued. */
function sellerSnapshot(settings = {}) {
  return {
    legal_name: settings.legal_name || null,
    address_line1: settings.address_line1 || null,
    address_line2: settings.address_line2 || null,
    city: settings.city || null,
    state: settings.state || null,
    state_code: settings.state_code || null,
    postal_code: settings.postal_code || null,
    country: settings.country || DEFAULTS.country,
    gstin: settings.gstin || null,
    pan: settings.pan || null,
    email: settings.email || null,
    phone: settings.phone || null,
    notes: settings.invoice_notes || null,
  };
}

/**
 * Frozen copy of the buyer. Falls back to the studio's display name when no
 * billing name has been set, so an invoice is never addressed to nobody.
 */
function buyerSnapshot(org = {}) {
  return {
    organization_id: org.id || null,
    name: org.billing_name || org.name || null,
    email: org.billing_email || null,
    gstin: org.billing_gstin || null,
    address_line1: org.billing_address_line1 || null,
    address_line2: org.billing_address_line2 || null,
    city: org.billing_city || null,
    state: org.billing_state || null,
    state_code: org.billing_state_code || null,
    postal_code: org.billing_postal_code || null,
  };
}

/**
 * Everything an invoice row needs, computed once.
 * @param {object} args
 * @param {object} args.settings platform_billing_settings row
 * @param {object} args.org      organizations row
 * @param {number} args.amountInr what was charged
 */
function buildInvoiceTax({ settings, org, amountInr }) {
  const split = computeGstSplit({
    amountInr,
    gstPercent: settings.gst_percent,
    pricesIncludeGst: settings.prices_include_gst,
    sellerStateCode: settings.state_code,
    buyerStateCode: org?.billing_state_code,
  });
  return {
    ...split,
    seller_snapshot: sellerSnapshot(settings),
    buyer_snapshot: buyerSnapshot(org),
  };
}

module.exports = {
  DEFAULTS, loadSettings, computeGstSplit, buildInvoiceTax,
  sellerSnapshot, buyerSnapshot, money,
};
