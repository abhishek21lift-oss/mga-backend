// src/lib/subscriptionInvoicePdf.js
//
// The platform's tax invoice to a studio for its subscription.
//
// Not to be confused with upiReceiptPdf.js, which is a STUDIO's receipt to one
// of its MEMBERS. This is the other direction and the other document type: a
// receipt acknowledges money received, a tax invoice is the instrument the
// recipient claims input credit against, so it must carry both GSTINs, the
// tax split and the invoice number.
//
// Every figure printed here is read off the invoice ROW. Nothing is
// recalculated at print time — see the header comment in platformBilling.js
// for why. An invoice issued before migration 122 has no tax snapshot and is
// printed honestly, as a bill with tax not itemised, rather than having a
// plausible-looking split invented for it years after the fact.
//
// Returns the buffer; nothing is persisted. The route renders on demand behind
// the same super-admin gate as the rest of the Control Centre.
'use strict';

const PDFDocument = require('pdfkit');
const { fmtDate } = require('./pdfHelpers');

const INK = '#0B1220';
const MUTE = '#6B7280';
const RULE = '#E5E7EB';
const BRAND = '#0060E0';

/** ₹ with Indian digit grouping — 1,20,000.00, not 120,000.00. */
function formatInr(amount) {
  const n = Number(amount) || 0;
  return `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function addressLines(p = {}) {
  return [
    p.address_line1, p.address_line2,
    [p.city, p.state].filter(Boolean).join(', '),
    p.postal_code, p.country,
  ].filter((l) => l && String(l).trim());
}

/** One party block in a fixed-width column, so the two sit side by side. */
function drawParty(doc, { title, party, x, width }) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTE)
    .text(title.toUpperCase(), x, doc.y, { width, characterSpacing: 0.6 });
  doc.moveDown(0.25);
  doc.fontSize(10.5).font('Helvetica-Bold').fillColor(INK)
    .text(party?.name || party?.legal_name || '—', x, doc.y, { width });
  doc.font('Helvetica').fontSize(9).fillColor(MUTE);
  for (const line of addressLines(party)) doc.text(line, x, doc.y, { width });
  if (party?.gstin) {
    doc.fillColor(INK).font('Helvetica-Bold').text(`GSTIN: ${party.gstin}`, x, doc.y, { width });
    doc.font('Helvetica').fillColor(MUTE);
  }
  if (party?.pan) doc.text(`PAN: ${party.pan}`, x, doc.y, { width });
  if (party?.email) doc.text(party.email, x, doc.y, { width });
  if (party?.phone) doc.text(party.phone, x, doc.y, { width });
}

/** A right-aligned amount row in the totals block. */
function totalRow(doc, label, value, { bold = false, right, labelWidth = 150 } = {}) {
  const y = doc.y;
  const valueWidth = 110;
  const labelX = right - valueWidth - labelWidth;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
    .fillColor(bold ? INK : MUTE).fontSize(bold ? 11 : 10)
    .text(label, labelX, y, { width: labelWidth, align: 'right' });
  doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica')
    .text(value, right - valueWidth, y, { width: valueWidth, align: 'right' });
  doc.moveDown(bold ? 0.4 : 0.25);
}

/**
 * Render the invoice.
 *
 * @param {object} data
 * @param {object} data.invoice  subscription_invoices row (with its snapshots)
 * @param {object} [data.payment] subscription_payments row — method/reference
 * @param {object} [data.organization] fallback identity for legacy invoices
 * @param {object} [data.settings] fallback seller for legacy invoices
 * @param {string} [data.planName]
 * @returns {Promise<Buffer>}
 */
async function generateSubscriptionInvoicePdf({
  invoice, payment, organization, settings, planName,
}) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const colWidth = (right - left - 30) / 2;

  // Prefer the snapshot. The live rows are only a fallback for invoices issued
  // before snapshots existed — and using them is a stated approximation, not a
  // silent one: the footer says so.
  const seller = invoice.seller_snapshot || {
    legal_name: settings?.legal_name || 'MY PT STUDIO', gstin: settings?.gstin || null,
    address_line1: settings?.address_line1 || null, city: settings?.city || null,
    state: settings?.state || null, postal_code: settings?.postal_code || null,
    country: settings?.country || 'India', email: settings?.email || null,
    phone: settings?.phone || null, pan: settings?.pan || null,
    notes: settings?.invoice_notes || null,
  };
  const buyer = invoice.buyer_snapshot || {
    name: organization?.billing_name || organization?.name || null,
    gstin: organization?.billing_gstin || null,
    address_line1: organization?.billing_address_line1 || null,
    city: organization?.billing_city || null,
    state: organization?.billing_state || null,
    postal_code: organization?.billing_postal_code || null,
    email: organization?.billing_email || null,
  };
  const legacy = !invoice.seller_snapshot || invoice.taxable_value_inr == null;
  const refunded = invoice.status === 'refunded';

  // ── Header ──
  // Both sides are drawn from the SAME baseline, captured before the name is
  // written: a long legal name wraps to two lines, and anchoring the title to
  // doc.y afterwards would drop it against the wrapped second line.
  const headerTop = doc.y;
  doc.fontSize(18).font('Helvetica-Bold').fillColor(INK)
    .text(seller.legal_name || 'MY PT STUDIO', left, headerTop, { width: colWidth * 1.2 });
  const afterName = doc.y;
  doc.fontSize(15).font('Helvetica-Bold').fillColor(BRAND)
    .text('TAX INVOICE', left, headerTop + 3, { width: right - left, align: 'right' });
  doc.y = Math.max(afterName, doc.y);
  doc.moveDown(0.6);

  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(1).stroke();
  doc.moveDown(0.7);

  // ── Invoice meta ──
  const metaTop = doc.y;
  doc.fontSize(9).font('Helvetica').fillColor(MUTE).text('Invoice No.', left, metaTop);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text(invoice.invoice_number || '—', left, doc.y);

  doc.fontSize(9).font('Helvetica').fillColor(MUTE)
    .text('Issue Date', left + colWidth * 0.7, metaTop);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(INK)
    .text(fmtDate(invoice.issued_at), left + colWidth * 0.7, doc.y);

  if (refunded) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#DC2626')
      .text('REFUNDED', left, metaTop, { width: right - left, align: 'right' });
  }
  doc.moveDown(1);

  // ── Parties, side by side ──
  const partyTop = doc.y;
  drawParty(doc, { title: 'From', party: seller, x: left, width: colWidth });
  const afterSeller = doc.y;
  doc.y = partyTop;
  drawParty(doc, { title: 'Billed To', party: buyer, x: left + colWidth + 30, width: colWidth });
  doc.y = Math.max(afterSeller, doc.y) + 14;

  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(1).stroke();
  doc.moveDown(0.7);

  // ── Line item ──
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTE);
  const lineTop = doc.y;
  doc.text('DESCRIPTION', left, lineTop, { width: colWidth * 1.2 });
  doc.text('AMOUNT', right - 110, lineTop, { width: 110, align: 'right' });
  doc.moveDown(0.4);
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.moveDown(0.5);

  const period = (invoice.period_start && invoice.period_end)
    ? `${fmtDate(invoice.period_start)} to ${fmtDate(invoice.period_end)}`
    : null;
  const itemTop = doc.y;
  doc.fontSize(10.5).font('Helvetica-Bold').fillColor(INK)
    .text(`${planName || invoice.plan_code || 'Subscription'} — platform subscription`,
      left, itemTop, { width: colWidth * 1.2 });
  if (period) {
    doc.fontSize(9).font('Helvetica').fillColor(MUTE)
      .text(`Service period: ${period}`, left, doc.y, { width: colWidth * 1.2 });
  }
  doc.fontSize(10.5).font('Helvetica').fillColor(INK).text(
    formatInr(legacy ? invoice.amount_inr : invoice.taxable_value_inr),
    right - 110, itemTop, { width: 110, align: 'right' },
  );
  doc.moveDown(1);

  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.moveDown(0.6);

  // ── Totals ──
  if (legacy) {
    totalRow(doc, 'Amount', formatInr(invoice.amount_inr), { bold: true, right });
  } else {
    const rate = Number(invoice.gst_percent) || 0;
    const cgst = Number(invoice.cgst_inr) || 0;
    const sgst = Number(invoice.sgst_inr) || 0;
    const igst = Number(invoice.igst_inr) || 0;

    totalRow(doc, 'Taxable value', formatInr(invoice.taxable_value_inr), { right });
    // Only the applicable heads are printed. A zero CGST line next to a real
    // IGST line reads as an error to anyone checking the arithmetic.
    if (igst > 0) totalRow(doc, `IGST (${rate}%)`, formatInr(igst), { right });
    if (cgst > 0) totalRow(doc, `CGST (${rate / 2}%)`, formatInr(cgst), { right });
    if (sgst > 0) totalRow(doc, `SGST (${rate / 2}%)`, formatInr(sgst), { right });
    doc.moveDown(0.2);
    totalRow(doc, 'Total', formatInr(invoice.amount_inr), { bold: true, right });
  }
  doc.moveDown(0.8);

  // ── Payment ──
  if (payment) {
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTE).text('PAYMENT', left, doc.y);
    doc.moveDown(0.25);
    doc.fontSize(9).font('Helvetica').fillColor(INK);
    if (payment.method) doc.text(`Method: ${payment.method}`, left, doc.y);
    if (payment.reference) doc.text(`Reference: ${payment.reference}`, left, doc.y);
    if (payment.created_at) doc.text(`Received: ${fmtDate(payment.created_at)}`, left, doc.y);
    if (payment.refunded_at) {
      doc.fillColor('#DC2626').text(`Refunded: ${fmtDate(payment.refunded_at)}`, left, doc.y);
    }
    doc.moveDown(0.8);
  }

  // ── Footer ──
  if (seller.notes) {
    doc.fontSize(8.5).font('Helvetica').fillColor(MUTE)
      .text(seller.notes, left, doc.y, { width: right - left });
    doc.moveDown(0.5);
  }
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(RULE).lineWidth(1).stroke();
  doc.moveDown(0.5);

  const footer = [
    legacy
      ? 'Issued before tax itemisation was recorded; the amount shown is the total collected and is not broken down into tax components.'
      : 'Tax figures are as recorded when this invoice was issued.',
    'This invoice is computer generated and valid without a signature.',
  ].join(' ');
  doc.fontSize(8).font('Helvetica').fillColor(MUTE).text(footer, left, doc.y, {
    width: right - left, align: 'center',
  });

  doc.end();
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

module.exports = { generateSubscriptionInvoicePdf, formatInr };
