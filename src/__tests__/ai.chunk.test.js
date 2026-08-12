const { chunkText } = require('../lib/ai/chunk');

describe('chunkText', () => {
  it('returns no chunks for empty/whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps a short document as a single chunk', () => {
    const chunks = chunkText('One short paragraph about gym safety.', { chunkSize: 500, overlap: 50 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('One short paragraph about gym safety.');
  });

  it('never produces a chunk longer than chunkSize, even for an unbroken run of text', () => {
    const unbroken = 'X'.repeat(5000);
    const chunks = chunkText(unbroken, { chunkSize: 200, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });

  it('splits multi-sentence prose into multiple chunks once it exceeds chunkSize', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `This is sentence number ${i + 1} of a long SOP.`);
    const chunks = chunkText(sentences.join(' '), { chunkSize: 300, overlap: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should exceed the requested size.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
  });

  it('carries an overlapping tail from one chunk into the next', () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `Sentence ${i + 1} of the document is here.`);
    const chunks = chunkText(sentences.join(' '), { chunkSize: 120, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    // The tail of chunk[0] should reappear at the start of chunk[1].
    const tail = chunks[0].slice(-20);
    expect(chunks[1]).toContain(tail.trim().split(' ').slice(-2).join(' '));
  });

  it('respects paragraph boundaries when paragraphs individually fit', () => {
    const text = 'Paragraph one is short.\n\nParagraph two is also short.';
    const chunks = chunkText(text, { chunkSize: 1000, overlap: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Paragraph one is short.');
    expect(chunks[0]).toContain('Paragraph two is also short.');
  });
});
