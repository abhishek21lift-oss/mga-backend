// src/lib/ptEnrollmentPdf.js
// The PT enrolment form, as a document the studio can hand over or keep.
//
// Same pdfkit approach as parqPdf.js and informedConsentPdf.js, sharing their
// drawing helpers so the three documents look like they came from the same
// place.
//
// One deliberate difference: this returns a Buffer instead of writing to
// storage. Those two generate a record that is referred to again later, so a
// stored URL earns its keep. An enrolment form is generated from live client
// columns — nothing about it is fixed at generation time except the moment it
// was printed, so a stored copy would just be a stale copy of a query, and
// the studio would eventually download the wrong one.
'use strict';

const PDFDocument = require('pdfkit');
const { fmtDate, drawSectionHeading, drawLabelValue, embedSignature } = require('./pdfHelpers');

const METHOD_LABELS = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank Transfer',
  SPLIT: 'Split Payment',
};

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `INR ${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** Whole years between a date of birth and today, or null. */
function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/**
 * Builds the enrolment form for one pt_clients row.
 * @param {object} c a pt_clients row
 * @param {string} [studioName]
 * @returns {Promise<Buffer>}
 */
async function buildEnrollmentPdf(c, studioName = 'MY PT STUDIO') {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  doc.fontSize(18).font('Helvetica-Bold').fillColor('#111827')
    .text('Personal Training Enrolment', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#6B7280')
    .text(studioName, { align: 'center' });
  doc.moveDown();

  drawSectionHeading(doc, 'Client');
  drawLabelValue(doc, 'Name:', c.name);
  drawLabelValue(doc, 'Client ID:', c.unique_id || c.client_id);
  drawLabelValue(doc, 'Mobile:', c.mobile);
  drawLabelValue(doc, 'Email:', c.email);
  const age = ageFrom(c.dob);
  drawLabelValue(doc, 'Age:', age != null ? `${age}` : '—');
  drawLabelValue(doc, 'Current Weight:', c.weight ? `${c.weight} kg` : '—');
  drawLabelValue(doc, 'Goal:', c.goal);
  drawLabelValue(doc, 'Member Since:', fmtDate(c.joining_date || c.created_at));

  drawSectionHeading(doc, 'Programme');
  drawLabelValue(doc, 'Package:', c.package_type);
  drawLabelValue(doc, 'Trainer:', c.trainer_name);
  drawLabelValue(doc, 'Start Date:', fmtDate(c.pt_start_date));
  drawLabelValue(doc, 'End Date:', fmtDate(c.pt_end_date));
  drawLabelValue(doc, 'Duration:', c.duration_months ? `${c.duration_months} month(s)` : '—');
  drawLabelValue(doc, 'Training Mode:', c.training_mode);
  drawLabelValue(doc, 'Sessions / Week:', c.sessions_per_week);
  drawLabelValue(doc, 'Training Days:', c.preferred_training_days);
  drawLabelValue(doc, 'Preferred Time:', c.preferred_workout_time);
  drawLabelValue(doc, 'Experience Level:', c.workout_experience_level);

  drawSectionHeading(doc, 'Payment');
  drawLabelValue(doc, 'Final / Selling Price:', money(c.final_amount));
  drawLabelValue(doc, 'Amount Paid:', money(c.paid_amount));
  drawLabelValue(doc, 'Balance Due:', money(c.balance_amount));
  drawLabelValue(doc, 'Payment Method:', METHOD_LABELS[c.payment_method] || c.payment_method || '—');

  // Keep the agreement and its signature on one page — a signature orphaned
  // from the text it signs is not worth printing.
  if (doc.y > doc.page.height - 260) doc.addPage();
  drawSectionHeading(doc, 'Agreement');
  if (c.agreement_text) {
    doc.fontSize(9.5).fillColor('#374151').font('Helvetica').text(c.agreement_text, { align: 'left' });
    doc.moveDown(0.5);
  }
  drawLabelValue(doc, 'Accepted:', c.agreement_accepted_at ? fmtDate(c.agreement_accepted_at) : 'Not accepted');
  embedSignature(doc, 'Client Signature:', c.agreement_signature);

  doc.fontSize(8).fillColor('#6B7280').font('Helvetica');
  doc.text(`Generated: ${new Date().toISOString()}`);

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

module.exports = { buildEnrollmentPdf, ageFrom, METHOD_LABELS };
