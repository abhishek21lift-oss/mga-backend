// Portfolio rules — quotas, video links, and what a reorder may say.
//
// The reorder case is the one worth the most care: it is the only mutation
// that is inherently about the whole list, and getting it wrong loses work
// silently rather than loudly.
'use strict';

const p = require('../lib/portfolio');

describe('parseVideoUrl', () => {
  it('accepts YouTube and Vimeo over https', () => {
    expect(p.parseVideoUrl('https://www.youtube.com/watch?v=abc123').value.provider).toBe('youtube');
    expect(p.parseVideoUrl('https://youtu.be/abc123').value.provider).toBe('youtube');
    expect(p.parseVideoUrl('https://vimeo.com/12345').value.provider).toBe('vimeo');
    expect(p.parseVideoUrl('https://player.vimeo.com/video/12345').value.provider).toBe('vimeo');
  });

  it('refuses any other host', () => {
    // This string is rendered into an embed. An arbitrary origin there is how
    // a portfolio card becomes someone else's page.
    for (const url of ['https://evil.example/video', 'https://youtube.com.evil.example/x']) {
      expect(p.parseVideoUrl(url).error).toMatch(/YouTube and Vimeo/);
    }
  });

  it('refuses http, which no browser will embed anyway', () => {
    expect(p.parseVideoUrl('http://www.youtube.com/watch?v=a').error).toMatch(/https/);
  });

  it('refuses javascript: and data: URLs outright', () => {
    expect(p.parseVideoUrl('javascript:alert(1)').error).toBeTruthy();
    expect(p.parseVideoUrl('data:text/html,<script>').error).toBeTruthy();
  });

  it('strips credentials and fragments rather than storing them', () => {
    const r = p.parseVideoUrl('https://user:pw@vimeo.com/12345#t=30');
    expect(r.value.url).not.toContain('user');
    expect(r.value.url).not.toContain('#');
  });

  it('requires a value and rejects nonsense', () => {
    expect(p.parseVideoUrl('').error).toMatch(/required/);
    expect(p.parseVideoUrl('not a url').error).toMatch(/valid URL/);
  });
});

describe('checkQuota', () => {
  it('allows a normal image', () => {
    expect(p.checkQuota({ currentCount: 5, bytes: 1024 })).toEqual({ ok: true });
  });

  it('refuses once the gallery is full, with a 409', () => {
    const r = p.checkQuota({ currentCount: p.LIMITS.items, bytes: 1024 });
    expect(r.status).toBe(409);
    expect(r.error).toContain(String(p.LIMITS.items));
  });

  it('refuses an oversized file with a 413 that names the limit', () => {
    const r = p.checkQuota({ currentCount: 0, bytes: p.LIMITS.imageBytes + 1 });
    expect(r.status).toBe(413);
    expect(r.error).toMatch(/8MB/);
  });

  it('applies the smaller poster limit when told to', () => {
    const bytes = p.LIMITS.posterBytes + 1;
    expect(p.checkQuota({ currentCount: 0, bytes }).ok).toBe(true);
    expect(p.checkQuota({ currentCount: 0, bytes, limitBytes: p.LIMITS.posterBytes }).status).toBe(413);
  });

  it('refuses an empty or malformed size', () => {
    for (const bytes of [0, -1, NaN, undefined]) {
      expect(p.checkQuota({ currentCount: 0, bytes }).status).toBe(400);
    }
  });
});

describe('checkPinLimit', () => {
  it('allows up to the limit and refuses beyond it', () => {
    expect(p.checkPinLimit(p.LIMITS.pinned - 1)).toEqual({ ok: true });
    expect(p.checkPinLimit(p.LIMITS.pinned).status).toBe(409);
  });
});

describe('validateOrder', () => {
  const have = ['a', 'b', 'c'];

  it('accepts a permutation of exactly what the user has', () => {
    expect(p.validateOrder(['c', 'a', 'b'], have).value).toEqual(['c', 'a', 'b']);
  });

  it('rejects a stale list with 409 rather than applying part of it', () => {
    // Two tabs open, one deletes an item, the other reorders. Applying what
    // matches would silently drop the delete.
    expect(p.validateOrder(['a', 'b'], have).status).toBe(409);
    expect(p.validateOrder(['a', 'b', 'c', 'd'], have).status).toBe(409);
  });

  it('rejects a same-size list with different members', () => {
    // The size check alone would let this through.
    expect(p.validateOrder(['a', 'b', 'z'], have).status).toBe(409);
  });

  it('rejects a duplicate id', () => {
    expect(p.validateOrder(['a', 'a', 'b'], have).status).toBe(400);
  });

  it('rejects a non-list and empty entries', () => {
    expect(p.validateOrder('a,b,c', have).status).toBe(400);
    expect(p.validateOrder(['a', '', 'c'], have).status).toBe(400);
  });

  it('accepts an empty reorder of an empty gallery', () => {
    expect(p.validateOrder([], []).value).toEqual([]);
  });
});

describe('present', () => {
  const row = {
    id: 'i1', kind: 'before_after', title: 'T', caption: 'C',
    file_key: 'portfolio/aaa.jpg', file_url: '/uploads/portfolio/aaa.jpg',
    after_file_key: 'portfolio/bbb.jpg', after_file_url: '/uploads/portfolio/bbb.jpg',
    file_size_bytes: '1000', after_file_size_bytes: '500',
    external_url: null, pinned: true, sort_order: 2, created_at: 'now',
  };

  it('exposes no raw column names — only the served URLs', () => {
    // The URL necessarily contains the key as a substring, since /uploads/<key>
    // is how the object is addressed; asserting otherwise would be asserting
    // that the image cannot be fetched. What must not appear is the raw column
    // surface — file_key, mime_type, sizes, organization_id, user_id — which is
    // internal and, in uploads.js, is what authorisation is keyed on.
    const out = p.present(row);
    expect(Object.keys(out).sort()).toEqual([
      'afterUrl', 'bytes', 'caption', 'createdAt', 'externalUrl',
      'id', 'kind', 'pinned', 'sortOrder', 'title', 'url',
    ]);
  });

  it('sums both assets into one byte figure', () => {
    // BIGINT arrives as a string from node-postgres; string concatenation here
    // would report "1000500" bytes.
    expect(p.present(row).bytes).toBe(1500);
  });

  it('copes with a single-asset row', () => {
    expect(p.present({ ...row, after_file_size_bytes: null, after_file_url: null }).bytes).toBe(1000);
  });
});
