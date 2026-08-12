// src/lib/informedConsentPdf.js
// Generates the Personal Training Informed Consent PDF. Same pdfkit
// approach as parqPdf.js (see that file for the rationale) — shares its
// drawing helpers via pdfHelpers.js.
const PDFDocument = require('pdfkit');
const { fmtDate, drawSectionHeading, drawLabelValue, embedSignature } = require('./pdfHelpers');
const { saveFile } = require('./fileStorage');

const ACK_LABELS = {
  understands_confidentiality: 'I understand my personal and medical information will remain confidential and used only for my training program.',
  voluntary_participation: 'I understand participation is voluntary and I can withdraw at any time.',
  final_declaration: 'I confirm I have read this entire document, understand the risks and benefits, asked my questions, had them answered, and voluntarily agree to participate.',
};

/**
 * Generates the Informed Consent PDF and writes it to
 * uploads/informed-consent/pdf/<id>.pdf. Returns the served URL.
 *
 * @param {object} record - a pt_informed_consents row.
 */
async function generateInformedConsentPdf(record) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  doc.fontSize(18).font('Helvetica-Bold').fillColor('#111827')
    .text('Personal Training Informed Consent', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#6B7280')
    .text('MY PT STUDIO', { align: 'center' });
  doc.moveDown();

  drawSectionHeading(doc, 'Client Details');
  drawLabelValue(doc, 'Name:', record.full_name);
  drawLabelValue(doc, 'Date of Birth:', fmtDate(record.dob));
  drawLabelValue(doc, 'Gender:', record.gender);
  drawLabelValue(doc, 'Mobile:', record.mobile);
  drawLabelValue(doc, 'Email:', record.email);
  drawLabelValue(doc, 'Address:', record.address);
  drawLabelValue(doc, 'Occupation:', record.occupation);
  drawLabelValue(doc, 'Emergency Contact:', record.emergency_contact ? `${record.emergency_contact} (${record.emergency_phone || '—'})` : '—');

  drawSectionHeading(doc, 'Nature of the Personal Training Program');
  doc.fontSize(9.5).fillColor('#374151').font('Helvetica').text(
    'The fitness program is designed to improve cardiovascular health, respiratory fitness, muscular '
    + 'strength and endurance, flexibility, mobility, body composition, and functional fitness. Sessions '
    + 'may include cardio, strength training, resistance training, functional training, HIIT, stretching, '
    + 'mobility work, and recovery.'
  );

  drawSectionHeading(doc, 'Potential Risks & Benefits');
  doc.fontSize(9.5).fillColor('#374151').font('Helvetica').text(
    'Risks may include muscle soreness or strain, joint discomfort, elevated heart rate or blood pressure, '
    + 'fatigue, dizziness, falls, or injury. Benefits may include improved heart health, endurance, fat loss, '
    + 'muscle gain, posture, mobility, flexibility, reduced disease risk, and improved mental health and '
    + 'quality of life.'
  );

  if (record.physician_advised_against) {
    drawSectionHeading(doc, 'Medical Clearance');
    drawLabelValue(doc, 'Physician:', record.physician_name);
    drawLabelValue(doc, 'Hospital:', record.hospital);
    drawLabelValue(doc, 'Condition:', record.medical_condition);
    drawLabelValue(doc, 'Clearance on file:', record.medical_clearance_file_url ? 'Yes' : 'No');
  }

  doc.moveDown();
  if (doc.y > doc.page.height - 260) doc.addPage();
  drawSectionHeading(doc, 'Acknowledgements');
  const acks = record.acknowledgements || {};
  for (const [key, label] of Object.entries(ACK_LABELS)) {
    const checked = acks[key] === true;
    if (doc.y > doc.page.height - 80) doc.addPage();
    doc.fontSize(9.5).fillColor(checked ? '#059669' : '#DC2626').font('Helvetica-Bold')
      .text(checked ? '[x] ' : '[ ] ', { continued: true });
    doc.fillColor('#111827').font('Helvetica').text(label);
  }

  if (record.exercise_consent_text) {
    doc.moveDown();
    if (doc.y > doc.page.height - 260) doc.addPage();
    drawSectionHeading(doc, 'Exercise Programme Consent');
    doc.fontSize(9.5).fillColor('#374151').font('Helvetica').text(record.exercise_consent_text);
    doc.moveDown(0.5);
    doc.fontSize(9.5).fillColor(record.exercise_consent_checked ? '#059669' : '#DC2626').font('Helvetica-Bold')
      .text(record.exercise_consent_checked ? '[x] ' : '[ ] ', { continued: true });
    doc.fillColor('#111827').font('Helvetica')
      .text('I have read and understood the above consent and agree to participate in the exercise programme.');
    doc.moveDown(0.5);
    drawLabelValue(doc, 'Date:', fmtDate(record.exercise_consent_date));
    embedSignature(doc, `Client signature (signed ${fmtDate(record.exercise_consent_signed_at)}):`, record.exercise_consent_signature);
  }

  doc.moveDown();
  if (doc.y > doc.page.height - 220) doc.addPage();
  drawSectionHeading(doc, 'Signatures');
  embedSignature(doc, `Client Signature (signed ${fmtDate(record.client_signed_at)}):`, record.client_signature);
  embedSignature(doc, `Trainer Signature (signed ${fmtDate(record.trainer_signed_at)}):`, record.trainer_signature);
  if (record.witness_signature) {
    embedSignature(doc, `Witness Signature — ${record.witness_name || '—'} (signed ${fmtDate(record.witness_signed_at)}):`, record.witness_signature);
  }

  drawSectionHeading(doc, 'Record Metadata');
  doc.fontSize(8).fillColor('#6B7280').font('Helvetica');
  doc.text(`Version: ${record.version}`);
  doc.text(`Status: ${String(record.status || '').toUpperCase()}`);
  doc.text(`IP Address: ${record.ip_address || '—'}`);
  doc.text(`Device: ${record.device || '—'}    Browser: ${record.browser || '—'}`);
  doc.text(`Generated: ${new Date().toISOString()}`);

  doc.end();

  const buffer = await new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // As in parqPdf: the signer is a client, not a user, so only the studio is
  // known at this point.
  return saveFile('informed-consent/pdf', `${record.id}.pdf`, buffer, 'application/pdf',
    { organizationId: record?.organization_id });
}

module.exports = { generateInformedConsentPdf };
