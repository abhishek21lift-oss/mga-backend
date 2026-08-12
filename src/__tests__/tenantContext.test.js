'use strict';
// The AsyncLocalStorage plumbing TENANT-RLS-PLAN.md calls for, carrying an
// org id from the auth middleware down to db/pool.js's query wrapper
// without threading it through 839 call sites as an explicit argument.

const { runWithTenantContext, currentOrgId } = require('../lib/tenant-context');

describe('tenant-context', () => {
  it('is null outside any context — a background job or unauthenticated route', () => {
    expect(currentOrgId()).toBeNull();
  });

  it('makes the org id available anywhere inside the callback, across an await', async () => {
    await runWithTenantContext('org-1', async () => {
      await Promise.resolve();
      expect(currentOrgId()).toBe('org-1');
    });
  });

  it('returns to null once the callback finishes', async () => {
    await runWithTenantContext('org-1', () => {});
    expect(currentOrgId()).toBeNull();
  });

  it('keeps two concurrent contexts from bleeding into each other', async () => {
    // The actual failure mode a per-request context has to rule out: two
    // requests for different studios in flight at once must never see each
    // other's org id, however their awaits happen to interleave.
    const seenA = [];
    const seenB = [];
    await Promise.all([
      runWithTenantContext('org-a', async () => {
        seenA.push(currentOrgId());
        await new Promise((r) => setTimeout(r, 5));
        seenA.push(currentOrgId());
      }),
      runWithTenantContext('org-b', async () => {
        seenB.push(currentOrgId());
        await new Promise((r) => setTimeout(r, 1));
        seenB.push(currentOrgId());
      }),
    ]);
    expect(seenA).toEqual(['org-a', 'org-a']);
    expect(seenB).toEqual(['org-b', 'org-b']);
  });

  it('nesting resumes the outer org id once the inner context returns', async () => {
    await runWithTenantContext('outer', async () => {
      await runWithTenantContext('inner', async () => {
        expect(currentOrgId()).toBe('inner');
      });
      expect(currentOrgId()).toBe('outer');
    });
  });

  it('propagates the return value', () => {
    expect(runWithTenantContext('org-1', () => 'ok')).toBe('ok');
  });

  it('rethrows synchronously for a sync callback and via rejection for an async one', async () => {
    expect(() => runWithTenantContext('org-1', () => { throw new Error('boom'); })).toThrow('boom');
    await expect(runWithTenantContext('org-1', async () => { throw new Error('boom-async'); }))
      .rejects.toThrow('boom-async');
  });
});
