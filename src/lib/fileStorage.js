// src/lib/fileStorage.js
// Persists uploaded/generated files to S3-compatible object storage when
// credentials are configured via env vars, falling back to local disk
// otherwise. Render's filesystem is ephemeral — everything under uploads/ is
// wiped on every deploy/restart — so production must use object storage; local
// dev keeps working unmodified with no storage account at all.
//
// ── Any S3-compatible provider, not only Cloudflare ─────────────────────────
//
// The endpoint used to be built from R2_ACCOUNT_ID alone:
//
//     endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
//
// which hardcoded Cloudflare as the only possible provider. That is a real
// constraint rather than a detail: server.js makes object storage a FATAL boot
// requirement in production, so the choice of vendor was effectively mandatory
// to run this software at all — and Cloudflare asks for a payment method even
// on the free tier.
//
// R2_S3_ENDPOINT overrides it. Unset, everything behaves exactly as before and
// no existing deployment changes. Set, it points at any S3-compatible service —
// Supabase Storage, Backblaze B2, MinIO, AWS S3 itself — which matters most for
// a deployment already using Supabase for its database, where storage comes
// with the project it already has.
//
// The variables keep their R2_ names. Renaming them would break every existing
// deployment for cosmetic gain, and the audit's own rule is that a rename is a
// migration, not a tidy-up.
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

/**
 * The S3 endpoint to talk to.
 *
 * R2_S3_ENDPOINT wins when set; otherwise the Cloudflare URL is derived from
 * R2_ACCOUNT_ID exactly as before. A trailing slash is trimmed because the AWS
 * SDK builds `${endpoint}/${bucket}/${key}` and a double slash is a different
 * object key on some providers — a failure that shows up as a 404 on a file
 * that was definitely uploaded.
 */
function s3Endpoint() {
  const override = String(process.env.R2_S3_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (override) return override;
  return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

let _s3Client = null;
function getS3Client() {
  if (_s3Client) return _s3Client;
  _s3Client = new S3Client({
    // 'auto' is Cloudflare's convention and is what every existing deployment
    // uses. Other providers require their real region — Supabase and AWS both
    // reject 'auto' with a SignatureDoesNotMatch, which is an unhelpful error
    // for what is actually a configuration problem.
    region: String(process.env.R2_REGION || '').trim() || 'auto',
    endpoint: s3Endpoint(),
    // Path-style addressing: `endpoint/bucket/key` rather than
    // `bucket.endpoint/key`. R2 accepts both; Supabase, MinIO and most
    // self-hosted gateways only accept path-style, and the SDK defaults to
    // virtual-host style, so without this those providers fail DNS resolution
    // on a hostname that was never going to exist.
    forcePathStyle: true,
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

module.exports = {
  isR2Configured, saveFile, serveFile, getFileBuffer, deleteFile,
  // Exported for the endpoint test only. The S3 client is memoised and built
  // lazily on first upload, so there is no other way to assert which endpoint,
  // region and addressing style a given set of env vars produces — and all
  // three fail quietly enough that asserting them is worth one exported name.
  _getS3ClientForTest: getS3Client,
};
