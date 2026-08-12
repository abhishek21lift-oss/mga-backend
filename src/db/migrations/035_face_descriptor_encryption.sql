-- 035_face_descriptor_encryption.sql
--
-- Adds an optional encrypted descriptor column to face_descriptors.
-- The backend will write AES-256-GCM ciphertext here (base64-encoded)
-- when FACE_ENCRYPTION_KEY is set, while keeping the legacy `descriptor`
-- column for backwards compatibility until all rows are re-enrolled.
--
-- Migration strategy:
--   * New enrollments → descriptor_enc populated, descriptor set to NULL
--   * Old rows       → descriptor_enc IS NULL, descriptor still readable
--   * Read path      → prefer descriptor_enc when present, else descriptor

ALTER TABLE face_descriptors
  ADD COLUMN IF NOT EXISTS descriptor_enc TEXT;

COMMENT ON COLUMN face_descriptors.descriptor_enc IS
  'AES-256-GCM encrypted face descriptor (base64: iv||authTag||ciphertext). '
  'Populated when FACE_ENCRYPTION_KEY env var is configured on the backend.';
