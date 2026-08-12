// The storage ledger's one job that can go wrong quietly: it must record the
// right number of bytes, and it must never break the upload it is measuring.
//
// The aggregation SQL is verified against a real Postgres in the live harness
// (see the commit message) because SUM ... FILTER semantics are not something
// a mock can prove. What is checked here is the normalisation and, more
// importantly, the failure posture.
'use strict';

// db/pool exits the process when DATABASE_URL is unset, so the lazy require
// inside the ledger needs a stand-in for the one test that exercises the
// default path. Everything else injects its own client explicitly.
jest.mock('../db/pool', () => ({ query: jest.fn(() => Promise.resolve({ rows: [] })) }));

const ledger = require('../lib/storageLedger');

/** A client that records statements and can be told to fail. */
function makeDb(behaviour = 'ok') {
  const calls = [];
  return {
    calls,
    query: jest.fn((sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (behaviour === 'reject') return Promise.reject(new Error('deadlock detected'));
      if (behaviour === 'throw') throw new Error('pool exhausted');
      return Promise.resolve({ rows: [] });
    }),
  };
}

describe('record', () => {
  const OBJ = {
    key: 'parq/pdf/abc.pdf', bytes: 12345, category: 'parq/pdf',
    contentType: 'application/pdf', organizationId: 'org-1', uploadedBy: 'user-1',
  };

  it('writes the object with its bytes attributed to a studio', async () => {
    const db = makeDb();
    await ledger.record(OBJ, db);
    expect(db.calls[0].params).toEqual([
      'parq/pdf/abc.pdf', 'org-1', 'parq/pdf', 12345, 'application/pdf', 'user-1',
    ]);
  });

  it('upserts on the key, because re-writing a key replaces the object', async () => {
    // R2 has no second copy of a key. Two INSERTs for one object would report
    // twice the storage that exists.
    const db = makeDb();
    await ledger.record(OBJ, db);
    expect(db.calls[0].sql).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
  });

  it('keeps an existing attribution when a later write has none', async () => {
    // COALESCE(EXCLUDED..., existing): a regenerated PDF written by a path
    // without the studio in scope must not orphan bytes that were correctly
    // attributed the first time.
    const db = makeDb();
    await ledger.record(OBJ, db);
    expect(db.calls[0].sql)
      .toMatch(/organization_id = COALESCE\(EXCLUDED\.organization_id, storage_objects\.organization_id\)/);
  });

  it('clears deleted_at, since re-writing a deleted key means it exists again', async () => {
    const db = makeDb();
    await ledger.record(OBJ, db);
    expect(db.calls[0].sql).toMatch(/deleted_at = NULL/);
  });

  it('falls back to an unattributed row rather than not recording at all', async () => {
    // A call site with no studio still costs money. Recording it with a null
    // owner keeps the platform total right and makes the gap visible as
    // unattributed_bytes; skipping the write would understate the bill.
    const db = makeDb();
    await ledger.record({ key: 'org-logos/x.png', bytes: 10 }, db);
    expect(db.calls[0].params[1]).toBeNull();
    expect(db.calls[0].params[2]).toBe('unknown');
    expect(db.calls[0].params[5]).toBeNull();
  });

  describe('byte normalisation', () => {
    // bytes is BIGINT NOT NULL CHECK (bytes >= 0). Anything that would violate
    // that must be normalised here, not rejected by the database — a CHECK
    // violation is a logged warning and a lost row.
    const cases = [
      ['a float', 1024.7, 1024],
      ['a numeric string', '2048', 2048],
      ['a negative', -5, 0],
      ['undefined', undefined, 0],
      ['null', null, 0],
      ['NaN', NaN, 0],
      ['Infinity', Infinity, 0],
      ['a non-numeric string', 'big', 0],
      ['an empty buffer length', 0, 0],
    ];
    it.each(cases)('turns %s into %p', async (_label, input, expected) => {
      const db = makeDb();
      await ledger.record({ key: 'k', bytes: input }, db);
      expect(db.calls[0].params[3]).toBe(expected);
    });
  });
});

describe('recordDelete', () => {
  it('soft-deletes so history survives a purge', async () => {
    const db = makeDb();
    await ledger.recordDelete('parq/pdf/abc.pdf', db);
    expect(db.calls[0].sql).toMatch(/SET deleted_at = now\(\)/);
    expect(db.calls[0].sql).not.toMatch(/DELETE FROM/);
    expect(db.calls[0].params).toEqual(['parq/pdf/abc.pdf']);
  });

  it('will not re-stamp a row that is already deleted', async () => {
    // Otherwise a repeated delete would move the timestamp forward and make a
    // purge look more recent than it was.
    const db = makeDb();
    await ledger.recordDelete('k', db);
    expect(db.calls[0].sql).toMatch(/deleted_at IS NULL/);
  });
});

describe('the one rule: recording never breaks an upload', () => {
  it('swallows a rejected query', async () => {
    await expect(ledger.record({ key: 'k', bytes: 1 }, makeDb('reject'))).resolves.toBeUndefined();
  });

  it('swallows a rejected delete', async () => {
    await expect(ledger.recordDelete('k', makeDb('reject'))).resolves.toBeUndefined();
  });

  it('uses the shared pool when no client is passed, and still swallows', async () => {
    // The real call path: fileStorage passes no client. The pool is required
    // lazily so this module stays loadable without a database — see the mock
    // at the top of the file.
    const pool = require('../db/pool');
    pool.query.mockClear().mockRejectedValueOnce(new Error('connection reset'));
    await expect(ledger.record({ key: 'k', bytes: 1 })).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalled();
  });
});

describe('fileStorage integration', () => {
  // saveFile must not await the ledger. If it did, a slow metrics table would
  // add its latency to every upload, and a locked one would hang it.
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../lib/fileStorage.js'), 'utf8');

  it('never awaits a ledger call', () => {
    expect(source).not.toMatch(/await\s+storageLedger\./);
  });

  it('records deletions in both the R2 and the local-disk branch', () => {
    // Dev runs on disk and production on R2; a ledger call in only one of them
    // means the two environments disagree about what is stored.
    const deleteFn = source.slice(source.indexOf('async function deleteFile'));
    const body = deleteFn.slice(0, deleteFn.indexOf('\n}\n') + 3);
    expect((body.match(/storageLedger\.recordDelete/g) || []).length).toBe(2);
  });
});
