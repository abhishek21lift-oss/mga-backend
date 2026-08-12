// One check-in write path, and this is what holds it to one.
//
// The API grew four ways to create an attendance_logs row on a member's
// behalf: POST /api/qr/scan, POST /api/biometric-attend/mark, POST
// /api/attendance/biometric, and the member WebAuthn routes at /api/webauthn
// that identified the person for the first two. All four wrote the same table,
// and each had to independently get tenant scoping right — the qr and
// biometric-attend paths had already shipped the same cross-tenant defect
// twice, separately (see attendance.tenant-isolation.test.js).
//
// Deleting a route file is easy to half-do: the file goes, the mount stays,
// and the server crashes at boot on a MODULE_NOT_FOUND — or worse, the file
// stays, nothing references it, and it quietly remains reachable in
// production. These assertions read server.js and the routes directory as
// text, which is the only way to catch the second case.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');

/** Every path string passed to app.use(...) in server.js. */
function mountedPaths() {
  return [...server.matchAll(/app\.use\(\s*'([^']+)'/g)].map((m) => m[1]);
}

/** Every './routes/x' required by server.js. */
function mountedRouteModules() {
  return [...server.matchAll(/require\('\.\/routes\/([^']+)'\)/g)].map((m) => m[1]);
}

describe('exactly one check-in surface', () => {
  test('the removed check-in routers are not mounted', () => {
    const paths = mountedPaths();
    expect(paths).not.toContain('/api/biometric-attend');
    // Member fingerprint enrolment. NOT '/api/auth/webauthn', which is staff
    // passkey login — a different system, asserted below to still be here.
    expect(paths).not.toContain('/api/webauthn');
  });

  test('the QR check-in router is still mounted', () => {
    // The point of the change is that one way in survives, not none.
    expect(mountedPaths()).toContain('/api/qr');
    expect(mountedRouteModules()).toContain('qr-checkin');
  });

  test('staff passkey login is untouched', () => {
    expect(mountedPaths()).toContain('/api/auth/webauthn');
    expect(mountedRouteModules()).toContain('auth-webauthn');
  });

  test('the removed route files are gone, not merely unmounted', () => {
    // An unmounted file left on disk is one careless `app.use` from being
    // live again, and reviewers read mounts, not directory listings.
    for (const f of ['biometric-attend.js', 'webauthn.js']) {
      expect(fs.existsSync(path.join(SRC, 'routes', f))).toBe(false);
    }
  });

  test('every router server.js mounts actually exists', () => {
    // The inverse mistake: deleting the file and leaving the require, which
    // takes the whole API down at boot rather than degrading one screen.
    const missing = mountedRouteModules().filter(
      (m) => !fs.existsSync(path.join(SRC, 'routes', `${m}.js`)),
    );
    expect(missing).toEqual([]);
  });

  test('attendance.js no longer offers a second way to check in', () => {
    // POST /api/attendance/biometric took a member code and wrote the same
    // row the QR scan writes. The rest of this router reads and corrects
    // records, which is why the file stays.
    const attendance = fs.readFileSync(path.join(SRC, 'routes', 'attendance.js'), 'utf8');
    expect(attendance).not.toMatch(/router\.post\(\s*'\/biometric'/);
  });
});
