// src/lib/upiReceiptPdf.js
// Payment receipt for an approved manual-UTR payment.
//
// Same pdfkit approach as parqPdf.js / informedConsentPdf.js, and shares their
// drawing helpers — but this one returns the BUFFER rather than saving to
// object storage.
//
// Why not persist it: a receipt is a pure function of rows that are already
// immutable (the order snapshot, the submission's UTR, the activation window
// and the receipt number). Storing a copy adds an R2 object per payment that
// can drift from the record it describes, and gives an attacker a second,
// unauthenticated surface — /uploads keys are guessable-by-design UUIDs. So
// the route renders on demand behind the same tenant check as everything
// else, and there is nothing to leak.
'use strict';

const PDFDocument = require('pdfkit');
const { fmtDate, drawSectionHeading, drawLabelValue } = require('./pdfHelpers');

const INK = '#0B1220';
const MUTE = '#6B7280';
const RULE = '#E5E7EB';
const BRAND = '#0060E0';

/** ₹ with Indian digit grouping — 1,20,000.00, not 120,000.00. */
function formatInr(amount) {
  const n = Number(amount) || 0;
  return `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Render the receipt.
 *
 * Every value comes from a stored row; nothing is recomputed here. If the GST
 * split were re-derived at print time, a later change to the studio's GST rate
 * would silently rewrite an old receipt and stop it matching the bank
 * statement it is evidence for.
 *
 * @param {object} data
 * @param {object} data.order       payment_orders row (the price snapshot)
 * @param {object} data.submission  payment_submissions row (the UTR)
 * @param {object} data.activation  membership_payments row (receipt no, window)
 * @param {object} data.member      pt_clients row
 * @param {object} data.organization organizations row (studio name)
 * @returns {Promise<Buffer>} the PDF bytes
 */
async function generateUpiReceiptPdf({ order, submission, activation, member, organization }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  // ── Header ──
  doc.fontSize(20).font('Helvetica-Bold').fillColor(INK)
    .text(organization?.name || 'MY PT STUDIO', { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica').fillColor(MUTE)
    .text('Powered by MY PT STUDIO', { align: 'center' });
  doc.moveDown(0.8);

  doc.fontSize(15).font('Helvetica-Bold').fillColor(BRAND)
    .text('PAYMENT RECEIPT', { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica').fillColor(MUTE)
    .text(`Receipt No. ${activation.receipt_no}`, { align: 'center' });
  doc.moveDown(0.6);

  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(RULE).lineWidth(1).stroke();
  doc.moveDown(0.6);

  // ── Parties ──
  drawSectionHeading(doc, 'Member');
  drawLabelValue(doc, 'Name:', member?.name);
  drawLabelValue(doc, 'Mobile:', member?.mobile);
  drawLabelValue(doc, 'Email:', member?.email);

  drawSectionHeading(doc, 'Membership');
  drawLabelValue(doc, 'Plan:', order.plan_name);
  drawLabelValue(doc, 'Duration:', `${order.duration_months} month${order.duration_months === 1 ? '' : 's'}`);
  drawLabelValue(doc, 'Valid From:', fmtDate(activation.activated_from));
  drawLabelValue(doc, 'Valid Until:', fmtDate(activation.activated_to));

  // ── Amounts ──
  drawSectionHeading(doc, 'Amount');
  drawLabelValue(doc, 'Base Amount:', formatInr(order.base_amount));
  // A zero-GST line reads as an error to anyone checking the maths, so it is
  // omitted entirely rather than printed as "GST (0%) Rs. 0.00".
  if (Number(order.gst_amount) > 0) {
    drawLabelValue(doc, `GST (${Number(order.gst_percent)}%):`, formatInr(order.gst_amount));
  }
  doc.moveDown(0.2);
  doc.fontSize(12).font('Helvetica-Bold').fillColor(INK)
    .text(`Total Paid:  ${formatInr(activation.amount)}`);
  doc.font('Helvetica').fontSize(10);

  // ── Payment ──
  drawSectionHeading(doc, 'Payment Details');
  drawLabelValue(doc, 'Method:', 'UPI');
  drawLabelValue(doc, 'Paid To:', `${order.merchant_name} (${order.upi_id})`);
  drawLabelValue(doc, 'UPI Reference (UTR):', activation.utr);
  drawLabelValue(doc, 'Order No:', order.order_no);
  drawLabelValue(doc, 'Payment Submitted:', fmtDate(submission?.submitted_at));
  drawLabelValue(doc, 'Verified On:', fmtDate(activation.approved_at));

  // ── Footer ──
  doc.moveDown(1.2);
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(RULE).lineWidth(1).stroke();
  doc.moveDown(0.5);
  doc.fontSize(8).font('Helvetica').fillColor(MUTE).text(
    'This payment was made by UPI transfer and verified manually against the studio bank account. '
    + 'This receipt is computer generated and valid without a signature.',
    { align: 'center' }
  );
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor(MUTE)
    .text(`Generated ${new Date().toISOString()}`, { align: 'center' });

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

module.exports = { generateUpiReceiptPdf, formatInr };
