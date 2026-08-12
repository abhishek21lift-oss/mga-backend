'use strict';
// Splits extracted document text into overlapping chunks for embedding.
//
// Splits on paragraph boundaries first, then sentence boundaries, falling
// back to a hard character cut only when a single "sentence" is itself
// longer than chunkSize (e.g. a table dumped as one line). This keeps
// chunks semantically coherent instead of cutting mid-sentence, which
// matters for retrieval quality — a chunk that starts mid-word carries
// less standalone meaning for both the embedding and the model reading it.

const DEFAULT_CHUNK_SIZE = parseInt(process.env.AI_RAG_CHUNK_SIZE, 10) || 800;
const DEFAULT_CHUNK_OVERLAP = parseInt(process.env.AI_RAG_CHUNK_OVERLAP, 10) || 150;

function splitIntoSentences(paragraph) {
  // Simple sentence splitter — good enough for SOP/guide prose. Keeps the
  // delimiter attached to the preceding sentence.
  return paragraph.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [paragraph];
}

/**
 * chunkText(text, opts) → string[]
 * opts.chunkSize / opts.overlap default to AI_RAG_CHUNK_SIZE / AI_RAG_CHUNK_OVERLAP.
 */
function chunkText(text, opts = {}) {
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE;
  const overlap = Math.min(opts.overlap ?? DEFAULT_CHUNK_OVERLAP, chunkSize - 1);

  const normalised = text.replace(/\r\n/g, '\n').trim();
  if (!normalised) return [];

  const paragraphs = normalised.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const units = []; // sentence-ish pieces in reading order
  for (const para of paragraphs) {
    if (para.length <= chunkSize) {
      units.push(para);
    } else {
      units.push(...splitIntoSentences(para).map((s) => s.trim()).filter(Boolean));
    }
  }

  const chunks = [];
  let current = '';
  for (const unit of units) {
    // A single unit longer than chunkSize (rare: an unbroken table/URL/etc.)
    // — hard-cut it rather than let one chunk balloon past the embedding
    // model's effective context.
    if (unit.length > chunkSize) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < unit.length; i += chunkSize - overlap) {
        chunks.push(unit.slice(i, i + chunkSize));
      }
      continue;
    }

    const candidate = current ? `${current} ${unit}` : unit;
    if (candidate.length > chunkSize) {
      chunks.push(current);
      // Start the next chunk with the tail of the previous one (overlap),
      // so a concept split across the boundary still appears whole in one
      // of the two adjacent chunks.
      const tail = current.slice(Math.max(0, current.length - overlap));
      current = `${tail} ${unit}`.trim();
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks.filter((c) => c.trim().length > 0);
}

module.exports = { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP };
