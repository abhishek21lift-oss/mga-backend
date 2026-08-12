// Parses a REAL PDF end-to-end rather than mocking the parser.
//
// This exists because the first implementation pinned pdf-parse@1.1.1, whose
// bundled 2018-era pdf.js throws "bad XRef entry" on ordinary valid PDFs —
// so every single PDF upload failed in production while every test still
// passed, because nothing here ever actually parsed a PDF. Mocking the
// parser would reproduce exactly that blind spot, so this generates a
// genuine PDF with pdfkit (already a dependency, and the same library the
// app uses for consent/PAR-Q PDFs) and asserts the text comes back out.
//
// Requires NODE_OPTIONS=--experimental-vm-modules (set in package.json's test
// script): PDF.js loads its fallback worker through a dynamic import(), which
// Jest's VM refuses without that flag. Production runs under plain Node and
// is unaffected — this is purely a test-runner constraint.

const PDFDocument = require('pdfkit');
const { extractText, SUPPORTED_MIME_TYPES } = require('../lib/ai/textExtract');

const SOP_TITLE = 'Gym Cleaning SOP';
const SOP_BODY =
  'All equipment must be wiped down after every session. ' +
  'Staff perform a full floor clean at close. ' +
  'Sanitiser stations are refilled twice daily.';

/** Builds a real, text-layer PDF in memory and resolves its Buffer. */
function makeTextPdf() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(14).text(SOP_TITLE);
    doc.moveDown().fontSize(11).text(SOP_BODY);
    doc.end();
  });
}

describe('extractText', () => {
  it('declares the MIME types the upload route accepts', () => {
    expect(SUPPORTED_MIME_TYPES).toEqual(expect.arrayContaining(['application/pdf', 'text/plain']));
  });

  it('extracts the text layer from a real PDF', async () => {
    const pdf = await makeTextPdf();
    const text = await extractText(pdf, 'application/pdf');
    expect(text).toContain(SOP_TITLE);
    expect(text).toContain('wiped down after every session');
    // The ingest pipeline rejects anything under 20 chars as "no text layer",
    // so a healthy parse must comfortably clear that bar.
    expect(text.length).toBeGreaterThan(20);
  }, 30000);

  it('reads plain text files as-is', async () => {
    const text = await extractText(Buffer.from('  Front desk opening checklist  ', 'utf8'), 'text/plain');
    expect(text).toBe('Front desk opening checklist');
  });

  it('throws a descriptive error for an unsupported type', async () => {
    await expect(extractText(Buffer.from('x'), 'application/msword'))
      .rejects.toThrow(/Unsupported file type/);
  });

  it('throws a readable error on a corrupted PDF rather than returning empty text', async () => {
    const notAPdf = Buffer.from('%PDF-1.4 this is not actually a pdf', 'utf8');
    await expect(extractText(notAPdf, 'application/pdf'))
      .rejects.toThrow(/Could not read this PDF/);
  }, 30000);
});
