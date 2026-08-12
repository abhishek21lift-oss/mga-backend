// src/lib/pdfHelpers.js
// Small drawing helpers shared by pdfkit-based document generators
// (parqPdf.js, informedConsentPdf.js) so the header/section/signature
// layout stays visually consistent without copy-pasting per generator.

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toISOString().split('T')[0]; } catch { return String(d); }
}

function drawSectionHeading(doc, text) {
  doc.moveDown(0.5);
  doc.fontSize(13).fillColor('#111827').font('Helvetica-Bold').text(text);
  doc.moveTo(doc.x, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .strokeColor('#E5E7EB').lineWidth(1).stroke();
  doc.moveDown(0.5);
  doc.font('Helvetica').fillColor('#111827');
}

function drawLabelValue(doc, label, value) {
  doc.fontSize(10).fillColor('#6B7280').font('Helvetica').text(label, { continued: true });
  doc.fillColor('#111827').font('Helvetica-Bold').text(`  ${value ?? '—'}`);
  doc.font('Helvetica');
}

function embedSignature(doc, label, base64) {
  doc.fontSize(10).fillColor('#6B7280').text(label);
  if (base64 && typeof base64 === 'string' && base64.includes(',')) {
    try {
      const buf = Buffer.from(base64.split(',')[1], 'base64');
      doc.image(buf, { fit: [220, 80] });
    } catch {
      doc.fontSize(9).fillColor('#DC2626').text('(signature image could not be rendered)');
    }
  } else {
    doc.fontSize(9).fillColor('#DC2626').text('(not signed)');
  }
  doc.fillColor('#111827');
  doc.moveDown(0.5);
}

module.exports = { fmtDate, drawSectionHeading, drawLabelValue, embedSignature };
