// src/lib/fileStorage.js
// Persists uploaded/generated files to Cloudflare R2 (S3-compatible object
// storage) when R2 credentials are configured via env vars, falling back to
// local disk otherwise. Render's filesystem is ephemeral — everything under
// uploads/ is wiped on every deploy/restart — so production must use R2;
// local dev keeps working unmodified without any Cloudflare account.
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const storageLedger = require('./storageLedger');
const { NodeHttpHandler } = require('@smithy/node-http-handler');

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads');
const R2_BUCKET = process.env.R2_BUCKET || 'client-files';

function isR2Configured() {
  return Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

let _s3Client = null;
function getS3Client() {
  if (_s3Client) return _s3Client;
  _s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    // The AWS SDK v3's default Node HTTP handler has NO timeout at all unless
    // one is set explicitly — a stalled TCP connection (as opposed to an
    // actively-refused one) would hang a GetObjectCommand/DeleteObjectCommand
    // forever with no error. That's a silent, permanent hang for anything
    // that awaits it: a knowledge-base document's ingestion (which reads the
    // file before it can even start chunking/embedding) and its deletion
    // (which deletes the file before the DB row) both depend on this client.
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 8000,
      requestTimeout: 20000,
    }),
    // Keep total retry latency bounded too — 3 retries with exponential
    // backoff on top of an already-timed-out request just triples the wait
    // before the caller ever finds out something is wrong.
    maxAttempts: 2,
  });
  return _s3Client;
}

/**
 * Persists `buffer` under `<category>/<filename>` and returns the URL the
 * app stores/serves (`/uploads/<category>/<filename>` either way — the
 * `/uploads` route transparently proxies from R2 or disk).
 *
 * `meta` is optional and purely for storage accounting: pass
 * `{ organizationId, uploadedBy }` where the caller has them, and the write is
 * attributed to that studio. Omitting it records the bytes with no owner
 * rather than not recording them, so the platform total stays right even
 * where attribution is not available. The ledger write is fire-and-forget and
 * cannot fail this function — see lib/storageLedger.js.
 */
async function saveFile(category, filename, buffer, contentType, meta = {}) {
  const key = `${category}/${filename}`;
  if (isR2Configured()) {
    await getS3Client().send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
  } else {
    const dir = path.join(UPLOADS_ROOT, category);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buffer);
  }

  storageLedger.record({
    key,
    bytes: buffer?.length ?? 0,
    category,
    contentType,
    organizationId: meta.organizationId,
    uploadedBy: meta.uploadedBy,
  });

  return `/uploads/${key}`;
}

/**
 * Streams the object at `key` (e.g. "parq/pdf/<id>.pdf") to an Express
 * response, from R2 or disk depending on configuration. Sends 404 if
 * missing; `key` must already be validated by the caller (no "..").
 */
async function serveFile(key, res, { maxAgeSeconds } = {}) {
  if (isR2Configured()) {
    try {
      const result = await getS3Client().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
      if (result.ContentType) res.type(result.ContentType);
      if (maxAgeSeconds) res.set('Cache-Control', `public, max-age=${maxAgeSeconds}`);
      result.Body.pipe(res);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: 'Not found' });
      }
      throw err;
    }
    return;
  }
  const filePath = path.join(UPLOADS_ROOT, key);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  if (maxAgeSeconds) res.set('Cache-Control', `public, max-age=${maxAgeSeconds}`);
  res.sendFile(filePath);
}

/**
 * Reads the object at `key` fully into memory and returns its Buffer, from
 * R2 or disk depending on configuration. Unlike serveFile(), this does not
 * write to an HTTP response — for callers that need the raw bytes (e.g. to
 * extract text for indexing). Throws if the object does not exist.
 */
async function getFileBuffer(key) {
  if (isR2Configured()) {
    const result = await getS3Client().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of result.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  const filePath = path.join(UPLOADS_ROOT, key);
  return fs.promises.readFile(filePath);
}

/**
 * Deletes the object at `key` from R2 or disk. Safe to call on a
 * already-missing object — DeleteObjectCommand and fs unlink-if-exists both
 * treat that as a no-op rather than an error.
 */
async function deleteFile(key) {
  if (isR2Configured()) {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    storageLedger.recordDelete(key);
    return;
  }
  const filePath = path.join(UPLOADS_ROOT, key);
  await fs.promises.rm(filePath, { force: true });
  storageLedger.recordDelete(key);
}

module.exports = { isR2Configured, saveFile, serveFile, getFileBuffer, deleteFile };
