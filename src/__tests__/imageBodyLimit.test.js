// Which endpoints may post an image, and which may not.
//
// A client profile photo never saved. The upload was fine, the route was fine,
// the column was fine — `express.json({ limit: '100kb' })` rejected the request
// with 413 before the route ever ran. The photo is cropped to an 800px JPEG at
// q0.8 in the browser first, which sounds small: measured in Chromium as the
// JSON body actually posted, a smooth gradient is 14 KB and a detailed image is
// 529 KB. A photograph of a person sits near the second number.
//
// It had been broken since the feature shipped — the new-client flow posts to
// the same endpoint — which is why no client in the database has a photo.
//
// The fix raises the limit for three paths and no others, so this file guards
// both directions. Getting it wrong the generous way is worse than the bug:
// a 4mb body limit on every endpoint is a denial-of-service budget.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const fs = require('fs');
const path = require('path');

/** The matchers, lifted from server.js rather than retyped. Retyping them is
 *  how a guard drifts from the thing it guards. */
function loadPatterns() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/const IMAGE_JSON_PATHS = \[([\s\S]*?)\];/);
  if (!block) throw new Error('IMAGE_JSON_PATHS not found in server.js');
  return eval(`[${block[1]}]`);
}

const PATTERNS = loadPatterns();
const matches = (p) => PATTERNS.some((re) => re.test(p));

describe('image bodies are allowed on exactly three paths', () => {
  test('the three that carry a base64 image', () => {
    expect(matches('/api/pt-os/clients/abc-123/photo')).toBe(true);
    expect(matches('/api/progress/progress-photos')).toBe(true);
    expect(matches('/api/pt-os/informed-consent/xyz-9/sign')).toBe(true);
  });

  test('nothing else, however close it looks', () => {
    // Each of these is a near miss that a sloppier regex would let through,
    // and every one of them would be a 4mb body budget on a route that has no
    // business receiving one.
    const outsiders = [
      '/api/pt-os/clients',
      '/api/pt-os/clients/abc-123',
      '/api/pt-os/clients/abc-123/notes',
      '/api/pt-os/clients/abc-123/photo/extra',
      '/api/progress/progress-photos/abc-123',
      '/api/pt-os/informed-consent/xyz-9',
      '/api/auth/login',
      '/api/clients/abc-123/photo',           // the deleted legacy route
    ].filter(matches);
    expect(outsiders).toEqual([]);
  });

  test('the raised limit is generous enough for a real photo, and bounded', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const raised = src.match(/const imageJson = express\.json\(\{ limit: '(\d+)mb' \}\)/);
    expect(raised).not.toBeNull();
    const mb = Number(raised[1]);
    // 529 KB was the measured worst case for one 800px image; a couple of
    // megabytes leaves room for a larger crop without becoming an upload
    // endpoint by accident.
    expect(mb).toBeGreaterThanOrEqual(1);
    expect(mb).toBeLessThanOrEqual(8);
  });

  test('everything else still gets the 100kb default', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(src).toContain("app.use(express.json({ limit: '100kb' }));");
    // And the narrow parser must be registered BEFORE the global one, or the
    // global one throws 413 first and the whole thing is decorative.
    expect(src.indexOf('const imageJson'))
      .toBeLessThan(src.indexOf("app.use(express.json({ limit: '100kb' }));"));
  });
});
