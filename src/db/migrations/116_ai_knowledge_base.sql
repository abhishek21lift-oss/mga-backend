-- 116_ai_knowledge_base.sql
-- Phase 1 of the AI Coach RAG upgrade: a document knowledge base (SOPs,
-- guides, policies) that the AI Coach retrieves from before answering,
-- instead of relying purely on general model knowledge.
--
-- Two tables:
--   ai_documents       — one row per uploaded file (R2-backed), with
--                        ingestion status (processing/ready/failed).
--   ai_document_chunks — the chunked, embedded text of each document.
--                        organization_id is denormalised here (not just
--                        joined from ai_documents) so the retrieval query
--                        can filter by tenant directly on the indexed
--                        table without a join in the hot path.
--
-- pgvector is already installed (046_branch_scope_and_pgvector.sql, for face
-- matching) — this just adds a second use of the same extension.
--
-- Embedding dimension is 384, matching the default local embedding model
-- (Xenova/all-MiniLM-L6-v2, see src/lib/ai/embeddings.js). If the embedding
-- model is ever changed to one with a different output dimension, existing
-- chunks must be re-embedded — the column width is not just cosmetic.
--
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ai_documents (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title            TEXT        NOT NULL,
  category         TEXT        NOT NULL DEFAULT 'guide' CHECK (category IN ('sop', 'guide', 'policy')),
  filename         TEXT        NOT NULL,
  file_key         TEXT        NOT NULL,        -- R2/disk object key, e.g. "knowledge/<id>.pdf"
  mime_type        TEXT        NOT NULL,
  file_size_bytes  INTEGER     NOT NULL,
  -- processing → ready is the happy path; failed carries error_message.
  -- Re-upload/reindex resets to 'processing' and clears chunks first.
  status           TEXT        NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  error_message    TEXT,
  chunk_count      INTEGER     NOT NULL DEFAULT 0,
  -- users.id is TEXT in this schema, not UUID.
  uploaded_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_documents_org ON ai_documents(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_document_chunks (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      UUID        NOT NULL REFERENCES ai_documents(id) ON DELETE CASCADE,
  organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  chunk_index      INTEGER     NOT NULL,
  content          TEXT        NOT NULL,
  embedding        vector(384),
  token_count      INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_document_chunks_document ON ai_document_chunks(document_id, chunk_index);

-- IVFFlat cosine-similarity index for retrieval. lists=100 is the same
-- heuristic used for face_descriptors (046) — appropriate up to a few
-- thousand chunks per install; revisit if a studio's knowledge base grows
-- far beyond that.
CREATE INDEX IF NOT EXISTS idx_ai_document_chunks_embedding
  ON ai_document_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Every other public table carries a deny-all policy for the PostgREST roles
-- (see migrations 059, 090, 100, 104). These hold internal SOPs/policies and
-- their embedded contents, so they follow the same rule. The Express backend
-- connects as a BYPASSRLS role and is unaffected; tenant isolation for the
-- app itself is enforced in src/lib/ai/knowledgeBase.js via organization_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_documents', 'ai_document_chunks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY deny_all_direct_access ON public.%I '
      'AS PERMISSIVE FOR ALL TO anon, authenticated '
      'USING (false) WITH CHECK (false)', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
