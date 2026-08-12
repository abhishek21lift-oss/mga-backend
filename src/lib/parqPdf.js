// src/lib/parqPdf.js
// Generates the PAR-Q + Health Screening + Digital Consent PDF.
//
// Phase 1 scope: legibility + completeness over pixel-perfect design.
// pdfkit was chosen over a headless-browser/HTML-to-PDF approach because
// it's a lightweight, dependency-light library — no Chromium binary to
// ship/run, which matters on a constrained Render instance.
const PDFDocument = require('pdfkit');
const { fmtDate, drawSectionHeading, drawLabelValue, embedSignature } = require('./pdfHelpers');
const { saveFile } = require('./fileStorage');

const CONSENT_LABELS = {
  info_true: 'I confirm that all the information provided above is true and accurate to the best of my knowledge.',
  understands_risk: 'I understand that physical exercise carries inherent risks, including the risk of injury.',
  will_inform_changes: 'I agree to inform my trainer of any changes to my health status before or during training.',
  understands_incorrect_info_risk: 'I understand that providing incorrect or incomplete information may put my health at risk.',
  voluntary_participation: 'I am participating in this training program voluntarily and of my own free will.',
  consents_emergency_care: 'I consent to receive emergency medical care/first aid if required during a session.',
  agrees_data_storage: 'I agree to my health data being securely stored and used for training purposes.',
};

/**
 * Generates the consent PDF for a PAR-Q form and writes it to
 * uploads/parq/pdf/<formId>.pdf. Returns the served URL
 * (/uploads/parq/pdf/<formId>.pdf).
 *
 * @param {object} formData - joined form + clearance + consent data:
 *   { form, clearance, consent }
 */
async function generateConsentPdf(formData) {
  const { form, clearance, consent } = formData;

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  // ── Header ──
  doc.fontSize(18).font('Helvetica-Bold').fillColor('#111827')
    .text('PAR-Q + Health Screening & Digital Consent', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#6B7280')
    .text('Physical Activity Readiness Questionnaire', { align: 'center' });
  doc.moveDown();

  drawSectionHeading(doc, 'Client Details');
  drawLabelValue(doc, 'Name:', form.full_name);
  drawLabelValue(doc, 'Date of Birth:', fmtDate(form.dob));
  drawLabelValue(doc, 'Gender:', form.gender);
  drawLabelValue(doc, 'Assessment Date:', fmtDate(form.assessment_date));
  drawLabelValue(doc, 'Trainer:', form.trainer_name);
  drawLabelValue(doc, 'Mobile:', form.mobile);
  drawLabelValue(doc, 'Emergency Contact:', form.emergency_contact ? `${form.emergency_contact} (${form.emergency_phone || '—'})` : '—');

  drawSectionHeading(doc, 'Risk Summary');
  drawLabelValue(doc, 'PAR-Q "Yes" Count:', `${form.parq_yes_count ?? 0} / 10`);
  drawLabelValue(doc, 'Risk Level:', String(form.risk_level || '').toUpperCase());
  drawLabelValue(doc, 'Risk Message:', form.risk_message);
  drawLabelValue(doc, 'Workout Gate Status:', String(form.workout_gate_status || '').toUpperCase());

  if (clearance) {
    drawSectionHeading(doc, 'Medical Clearance');
    drawLabelValue(doc, 'Doctor:', clearance.doctor_name);
    drawLabelValue(doc, 'Hospital:', clearance.hospital);
    drawLabelValue(doc, 'Clearance Date:', fmtDate(clearance.clearance_date));
    drawLabelValue(doc, 'Expiry Date:', fmtDate(clearance.expiry_date));
    drawLabelValue(doc, 'Approval Status:', String(clearance.approval_status || '').toUpperCase());
  }

  drawSectionHeading(doc, 'Consent Statements');
  const checkboxes = consent.consent_checkboxes || {};
  for (const [key, label] of Object.entries(CONSENT_LABELS)) {
    const checked = checkboxes[key] === true;
    doc.fontSize(10).fillColor(checked ? '#059669' : '#DC2626').font('Helvetica-Bold')
      .text(checked ? '[x] ' : '[ ] ', { continued: true });
    doc.fillColor('#111827').font('Helvetica').text(label);
  }

  doc.moveDown();
  if (doc.y > doc.page.height - 220) doc.addPage();
  drawSectionHeading(doc, 'Signatures');
  embedSignature(doc, `Client Signature (signed ${fmtDate(consent.client_signed_at)}):`, consent.client_signature);
  embedSignature(doc, `Trainer Signature (signed ${fmtDate(consent.trainer_signed_at)}):`, consent.trainer_signature);

  drawSectionHeading(doc, 'Record Metadata');
  doc.fontSize(8).fillColor('#6B7280').font('Helvetica');
  doc.text(`IP Address: ${consent.ip_address || '—'}`);
  doc.text(`Device: ${consent.device || '—'}    Browser: ${consent.browser || '—'}`);
  doc.text(`Location: ${consent.location || '—'}`);
  doc.text(`Generated: ${new Date().toISOString()}`);

  doc.end();

  const buffer = await new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Attribute the PDF's bytes to the studio that owns the form. There is no
  // req.user here — the client signs this, and a client is not a user — so
  // uploaded_by stays null while the studio is still known.
  return saveFile('parq/pdf', `${form.id}.pdf`, buffer, 'application/pdf',
    { organizationId: form?.organization_id });
}

module.exports = { generateConsentPdf };
