// lib/fileStorage.js — which S3 endpoint it actually talks to.
//
// server.js makes object storage a FATAL boot requirement in production, and
// the endpoint used to be built from R2_ACCOUNT_ID alone:
//
//     endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
//
// so Cloudflare was not a default, it was the only option — you could not run
// this software in production without an account there. R2_S3_ENDPOINT lifts
// that, and this pins both halves: the override works, and every deployment
// that does not set it keeps the exact URL it had.
//
// Worth testing rather than eyeballing because all three failure modes here are
// quiet. A wrong region signs requests that the provider rejects as
// SignatureDoesNotMatch — which reads as a credentials problem, not a config
// one. Virtual-host addressing against a provider that only does path-style
// fails DNS on a hostname that never existed. And a trailing slash produces a
// double slash in the key, so the upload succeeds and the download 404s.

'use strict';

const ORIGINAL = { ...process.env };

/** Fresh module + fresh S3Client capture per case: the client is memoised. */
function loadWith(env) {
  jest.resetModules();
  process.env = { ...ORIGINAL, ...env };

  const captured = {};
  jest.doMock('@aws-sdk/client-s3', () => ({
    S3Client: function S3Client(cfg) { Object.assign(captured, cfg); },
    PutObjectCommand: function () {},
    GetObjectCommand: function () {},
    DeleteObjectCommand: function () {},
  }));
  jest.doMock('../lib/storageLedger', () => ({
    record: jest.fn(), release: jest.fn(), usageFor: jest.fn(),
  }));

  const storage = require('../lib/fileStorage');
  return { storage, captured };
}

afterEach(() => { process.env = { ...ORIGINAL }; jest.resetModules(); });

const CREDS = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
};

describe('the S3 endpoint', () => {
  test('defaults to Cloudflare, exactly as before', () => {
    // The compatibility half. Every existing deployment sets only the three R2_
    // variables, and this asserts the URL they get is byte-for-byte the one the
    // hardcoded template produced.
    const { storage, captured } = loadWith(CREDS);
    storage._getS3ClientForTest();
    expect(captured.endpoint).toBe('https://acct123.r2.cloudflarestorage.com');
  });

  test('R2_S3_ENDPOINT overrides it', () => {
    const { storage, captured } = loadWith({
      ...CREDS,
      R2_S3_ENDPOINT: 'https://abc.supabase.co/storage/v1/s3',
    });
    storage._getS3ClientForTest();
    expect(captured.endpoint).toBe('https://abc.supabase.co/storage/v1/s3');
  });

  test('a trailing slash is trimmed', () => {
    // The SDK builds `${endpoint}/${bucket}/${key}`, so a trailing slash yields
    // a double slash — a different key on some providers. The upload succeeds
    // and the download 404s, which is the worst shape of bug to debug.
    const { storage, captured } = loadWith({
      ...CREDS,
      R2_S3_ENDPOINT: 'https://abc.supabase.co/storage/v1/s3///',
    });
    storage._getS3ClientForTest();
    expect(captured.endpoint).toBe('https://abc.supabase.co/storage/v1/s3');
  });

  test('an empty or whitespace override falls back rather than breaking', () => {
    // A Render variable set to "" is a very ordinary accident.
    const { storage, captured } = loadWith({ ...CREDS, R2_S3_ENDPOINT: '   ' });
    storage._getS3ClientForTest();
    expect(captured.endpoint).toBe('https://acct123.r2.cloudflarestorage.com');
  });
});

describe('region and addressing style', () => {
  test("region defaults to 'auto', Cloudflare's convention", () => {
    const { storage, captured } = loadWith(CREDS);
    storage._getS3ClientForTest();
    expect(captured.region).toBe('auto');
  });

  test('R2_REGION overrides it, for providers that reject auto', () => {
    // Supabase and AWS both refuse 'auto' with SignatureDoesNotMatch, which
    // reads as bad credentials rather than a bad region.
    const { storage, captured } = loadWith({ ...CREDS, R2_REGION: 'ap-south-1' });
    storage._getS3ClientForTest();
    expect(captured.region).toBe('ap-south-1');
  });

  test('path-style addressing is forced', () => {
    // The SDK defaults to virtual-host style (`bucket.endpoint/key`). R2 accepts
    // both; Supabase and MinIO only accept path-style, and the failure is a DNS
    // lookup on a hostname that was never going to resolve.
    const { storage, captured } = loadWith(CREDS);
    storage._getS3ClientForTest();
    expect(captured.forcePathStyle).toBe(true);
  });
});

describe('configuration detection is unchanged', () => {
  test('all three credentials present means configured', () => {
    const { storage } = loadWith(CREDS);
    expect(storage.isR2Configured()).toBe(true);
  });

  test('the endpoint override alone does NOT count as configured', () => {
    // server.js treats partial configuration as fatal in every environment.
    // An endpoint with no credentials must not read as "storage is set up".
    const { storage } = loadWith({ R2_S3_ENDPOINT: 'https://abc.supabase.co/storage/v1/s3' });
    expect(storage.isR2Configured()).toBe(false);
  });
});
