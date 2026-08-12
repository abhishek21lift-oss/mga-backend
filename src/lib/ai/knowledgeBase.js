'use strict';
// AI knowledge-base service: document ingestion (extract → chunk → embed →
// store) and retrieval (embed query → pgvector similarity search).
//
// Tenant isolation: every read and write here is scoped by organization_id.
// Retrieval never crosses that boundary — a studio's AI Coach can only ever
// be grounded in that same studio's own documents.

const pool = require('../../db/pool');
const logger = require('../logger');
const { getFileBuffer, deleteFile } = require('../fileStorage');
const { extractText } = require('./textExtract');
const { chunkText } = require('./chunk');
const { embedBatch, embedText, toVectorLiteral } = require('./embeddings');

const DEFAULT_TOP_K = parseInt(process.env.AI_RAG_TOP_K, 10) || 5;
const DEFAULT_SIMILARITY_THRESHOLD = parseFloat(process.env.AI_RAG_SIMILARITY_THRESHOLD) || 0.55;

/**
 * Runs the full ingestion pipeline for a document already inserted (with
 * status='processing') and its file already saved to storage. Intended to be
 * called fire-and-forget right after the upload response is sent — a
 * multi-page PDF can take well over Render's ~30s request timeout to embed
 * chunk-by-chunk on CPU, so this must never sit in the request/response path.
 */
async function ingestDocument(documentId) {
  const { rows } = await pool.query('SELECT * FROM ai_documents WHERE id = $1', [documentId]);
  const doc = rows[0];
  if (!doc) {
    logger.warn({ documentId }, 'ai_knowledge_ingest_missing_document');
    return;
  }

  try {
    const buffer = await getFileBuffer(doc.file_key);
    const text = await extractText(buffer, doc.mime_type);
    if (!text || text.length < 20) {
      // The parser ran fine but the file carries no text layer — almost
      // always a scanned/photographed document, where every page is an
      // image. Say that explicitly and give the fix, rather than a bare
      // "no text found" that reads like a bug in the app.
      throw new Error(
        doc.mime_type === 'application/pdf'
          ? 'This PDF has no selectable text — it looks like a scan or photos of pages. Re-export it as a text PDF (or run OCR on it) and upload again.'
          : 'No extractable text found in this document.'
      );
    }

    const chunks = chunkText(text);
    if (!chunks.length) {
      throw new Error('Document text could not be split into chunks.');
    }

    const vectors = await embedBatch(chunks);

    await pool.query('DELETE FROM ai_document_chunks WHERE document_id = $1', [documentId]);
    for (let i = 0; i < chunks.length; i++) {
      await pool.query(
        `INSERT INTO ai_document_chunks (document_id, organization_id, chunk_index, content, embedding, token_count)
         VALUES ($1, $2, $3, $4, $5::vector, $6)`,
        [documentId, doc.organization_id, i, chunks[i], toVectorLiteral(vectors[i]), Math.ceil(chunks[i].length / 4)]
      );
    }

    await pool.query(
      `UPDATE ai_documents SET status = 'ready', chunk_count = $2, error_message = NULL, updated_at = NOW() WHERE id = $1`,
      [documentId, chunks.length]
    );
    logger.info({ documentId, chunks: chunks.length }, 'ai_knowledge_ingest_complete');
  } catch (err) {
    logger.error({ documentId, err: err.message }, 'ai_knowledge_ingest_failed');
    await pool.query(
      `UPDATE ai_documents SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1`,
      [documentId, err.message.slice(0, 500)]
    ).catch(() => {});
  }
}

/**
 * Deletes a document: its row (chunks cascade via FK) first, then its stored
 * R2/disk file. Caller must have already verified organizationId ownership.
 *
 * The DB row is deleted BEFORE the file, and the file delete is
 * fire-and-forget rather than awaited — an R2 network hiccup deleting the
 * underlying object must never make "delete this document" hang or fail from
 * the user's side. An orphaned R2 object costs a little storage; a delete
 * button that never responds is a much worse outcome, and was exactly the
 * symptom reported (this mirrors the same R2-request-timeout fix applied to
 * fileStorage.js's S3Client — this fire-and-forget is what actually keeps the
 * user-facing delete fast regardless of how long R2 takes to answer).
 */
async function deleteDocument(documentId) {
  const { rows } = await pool.query('SELECT file_key FROM ai_documents WHERE id = $1', [documentId]);
  await pool.query('DELETE FROM ai_documents WHERE id = $1', [documentId]);
  if (rows[0]) {
    deleteFile(rows[0].file_key).catch((err) =>
      logger.warn({ documentId, err: err.message }, 'ai_knowledge_delete_file_failed')
    );
  }
}

/**
 * Embeds `query` and returns the top-K most similar chunks for this org,
 * above the similarity threshold — empty array if nothing qualifies (the
 * caller must then tell the model honestly that no matching documentation
 * was found, not let it guess).
 *
 * pgvector's `<=>` operator is cosine DISTANCE (0 = identical, 2 = opposite);
 * similarity = 1 - distance.
 */
async function retrieveContext({ organizationId, query, topK = DEFAULT_TOP_K, similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD }) {
  if (!organizationId || !query?.trim()) return [];

  let queryVector;
  try {
    queryVector = await embedText(query);
  } catch (err) {
    logger.error({ err: err.message }, 'ai_knowledge_query_embed_failed');
    return [];
  }

  const { rows } = await pool.query(
    `SELECT c.content, c.chunk_index, d.title, d.category, d.id AS document_id,
            1 - (c.embedding <=> $1::vector) AS similarity
     FROM ai_document_chunks c
     JOIN ai_documents d ON d.id = c.document_id
     WHERE c.organization_id = $2 AND d.status = 'ready'
     ORDER BY c.embedding <=> $1::vector ASC
     LIMIT $3`,
    [toVectorLiteral(queryVector), organizationId, topK]
  );

  return rows.filter((r) => Number(r.similarity) >= similarityThreshold);
}

module.exports = { ingestDocument, deleteDocument, retrieveContext };
