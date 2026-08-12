// The super-admin API stays split, and stays route-for-route what it was.
//
// Audit finding H-03. super-admin.routes.js was 4,248 lines and 98 routes in
// one module. It is now a mount list over src/modules/platform/super-admin/*.js.
//
// Two different things need guarding, and they fail in opposite directions:
//
//   1. The split must not have changed routing. A refactor that silently moves
//      or drops an endpoint is worse than the long file, because the long file
//      at least worked.
//   2. The file must not grow back. Nothing stops the next feature being
//      appended to the mount list, and after a few of those the split is
//      undone without anyone deciding to undo it.

const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

const ROOT = path.join(__dirname, '..', 'modules', 'platform', 'super-admin.routes.js');
const DIR = path.join(__dirname, '..', 'modules', 'platform', 'super-admin');

/**
 * Every route Express will actually match, in resolution order.
 *
 * Walks router.stack rather than parsing source, so it reflects runtime
 * behaviour including the order sub-routers were mounted in — which is the
 * property a split into mounted routers is most likely to change by accident.
 */
function routeTable(router, prefix = '', out = []) {
  for (const layer of router.stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m]).sort().join(',').toUpperCase();
      out.push({ verb: methods, path: prefix + layer.route.path });
    } else if (layer.handle && layer.handle.stack) {
      // Sub-routers are mounted at the root path, so they add no prefix.
      routeTable(layer.handle, prefix, out);
    }
  }
  return out;
}

/**
 * Pairs where one route would swallow requests meant for another: same verb,
 * same segment count, and a `:param` sitting where the other has a literal.
 *
 * With zero such pairs, mount ORDER cannot affect which handler runs — which is
 * what makes the split safe, and what let the two /organizations/:id/ai-limit
 * routes move into ai.js without changing behaviour.
 */
function shadowingPairs(routes) {
  const bad = [];
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i], b = routes[j];
      if (a.verb !== b.verb) continue;
      const as = a.path.split('/'), bs = b.path.split('/');
      if (as.length !== bs.length) continue;
      let shadows = true, sawParam = false;
      for (let k = 0; k < as.length; k++) {
        if (as[k].startsWith(':')) { if (!bs[k].startsWith(':')) sawParam = true; }
        else if (as[k] !== bs[k]) { shadows = false; break; }
      }
      if (shadows && sawParam) bad.push(`${a.verb} ${a.path} shadows ${b.path}`);
    }
  }
  return bad;
}

describe('super-admin API — the H-03 split', () => {
  const router = require('../modules/platform/super-admin.routes');
  const routes = routeTable(router);

  it('exposes exactly the routes the single file did — by path, not by count', () => {
    // Captured from the pre-split module before any file was touched.
    //
    // Pinned as a LIST rather than a count on purpose. A count alone passes
    // when a path is renamed or moved, which is the most likely way a
    // mechanical split goes wrong: I verified that gap by mutation, renaming
    // /storage/largest to /storage/largest_DISABLED — the count stayed 98 and
    // the suite went green. Comparing the set catches it.
    //
    // A failure here is either a deliberate new endpoint (add it below, and say
    // so in the commit) or an endpoint the refactor lost.
    const EXPECTED = [
    'DELETE /announcements/:id',
    'DELETE /coupons/:id',
    'DELETE /organizations/:id/ai-limit',
    'DELETE /organizations/:id/features/:key',
    'DELETE /organizations/:id/subscription/scheduled-change',
    'DELETE /users/:id',
    'GET /activity',
    'GET /ai/by-model',
    'GET /ai/by-studio',
    'GET /ai/overview',
    'GET /ai/routing',
    'GET /ai/settings',
    'GET /ai/trend',
    'GET /analytics',
    'GET /announcements',
    'GET /audit',
    'GET /audit/export',
    'GET /audit/filters',
    'GET /billing/invoices',
    'GET /billing/invoices/:id/pdf',
    'GET /billing/invoices/export',
    'GET /billing/settings',
    // Command Center (Phases 1 and 5). Deliberate additions, not refactor
    // drift — mounted under super-admin so the console inherits this mount's
    // auth -> requireSuperAdmin -> requireSuperAdminMfa chain rather than
    // standing up a second door to guard. That inheritance is the whole reason
    // the POST is allowed to exist: it pauses queues and deletes failed jobs,
    // so it must sit behind the strictest chain in the app.
    'GET /command-center/alerts',
    'GET /command-center/cards',
    'GET /command-center/commands',
    'GET /command-center/guardian',
    'GET /command-center/logs',
    'GET /command-center/logs/history',
    'GET /command-center/snapshot',
    'GET /coupons',
    'GET /coupons/:id/redemptions',
    'GET /features',
    'GET /features/:key/overrides',
    'GET /invitations',
    'GET /invitations/:id/events',
    'GET /mail/status',
    'GET /organizations',
    'GET /organizations/:id',
    'GET /organizations/:id/billing-profile',
    'GET /organizations/:id/features',
    'GET /organizations/:id/notes',
    'GET /organizations/:id/subscription',
    'GET /organizations/:id/subscription/change-quote',
    'GET /overview',
    'GET /platform-payment-settings',
    'GET /registrations',
    'GET /security/login-events',
    'GET /security/overview',
    'GET /security/sessions',
    'GET /security/threats',
    'GET /storage/by-studio',
    'GET /storage/largest',
    'GET /storage/overview',
    'GET /storage/trend',
    'GET /subscription-metrics',
    'GET /subscription-requests',
    'GET /subscriptions',
    'GET /support/overview',
    'GET /support/tickets',
    'GET /support/tickets/:id',
    'GET /system-health',
    'PATCH /announcements/:id',
    'PATCH /coupons/:id',
    'PATCH /features/:key',
    'PATCH /organizations/:id',
    'PATCH /organizations/:id/subscription/expiry',
    'PATCH /support/tickets/:id',
    'PATCH /users/:id',
    'POST /announcements',
    'POST /announcements/:id/cancel',
    'POST /announcements/:id/preview',
    'POST /announcements/:id/schedule',
    'POST /announcements/:id/send',
    'POST /command-center/alerts/:id/ack',
    'POST /command-center/alerts/:id/resolve',
    'POST /command-center/commands/:name',
    'POST /command-center/guardian/:id/explain',
    'POST /command-center/stream-ticket',
    'POST /coupons',
    'POST /invitations/:id/cancel',
    'POST /invitations/:id/link',
    'POST /invitations/:id/resend',
    // Mail health, added so an invisible SMTP outage can be diagnosed without
    // shell access to the box. GET verifies credentials without sending;
    // POST sends one real message and reports the SMTP dialogue.
    'POST /mail/test',
    'POST /organizations',
    'POST /organizations/:id/impersonate',
    'POST /organizations/:id/logo',
    'POST /organizations/:id/subscription/activate',
    'POST /organizations/:id/subscription/bonus-days',
    'POST /organizations/:id/subscription/cancel',
    'POST /organizations/:id/subscription/change',
    'POST /organizations/:id/subscription/founder',
    'POST /organizations/:id/subscription/freeze',
    'POST /organizations/:id/subscription/reactivate',
    'POST /organizations/:id/subscription/schedule-downgrade',
    'POST /organizations/:id/users',
    'POST /registrations/:id/approve',
    'POST /registrations/:id/reject',
    'POST /subscription-payments/:id/refund',
    'POST /subscription-requests/:id/approve',
    'POST /subscription-requests/:id/reject',
    'POST /support/tickets/:id/messages',
    'POST /users/:id/force-logout',
    'POST /users/:id/reset-mfa',
    'POST /users/:id/reset-password',
    'POST /users/:id/send-password-setup',
    'PUT /ai/rates/:model',
    'PUT /ai/routing',
    'PUT /ai/settings',
    'PUT /billing/settings',
    'PUT /features/:key/plans',
    'PUT /organizations/:id/ai-limit',
    'PUT /organizations/:id/billing-profile',
    'PUT /organizations/:id/features/:key',
    'PUT /organizations/:id/notes',
    'PUT /platform-payment-settings',
    ];
    const actual = routes.map((r) => `${r.verb} ${r.path}`).sort();
    expect(actual).toEqual(EXPECTED);
  });

  it('has no duplicate verb+path — two handlers for one URL', () => {
    // Mounting a router twice, or leaving a route behind in the old file while
    // copying it to a new one, shows up here and nowhere else: the first
    // registration wins and the second is dead code that looks live.
    const seen = new Map();
    const dupes = [];
    for (const r of routes) {
      const key = `${r.verb} ${r.path}`;
      if (seen.has(key)) dupes.push(key);
      seen.set(key, true);
    }
    expect(dupes).toEqual([]);
  });

  it('has no route shadowing another, so mount order cannot change behaviour', () => {
    // This is the invariant the whole refactor rests on. If it ever fails, the
    // failing pair must be reordered so the literal path is registered first —
    // and grouping routes by domain is no longer automatically safe.
    expect(shadowingPairs(routes)).toEqual([]);
  });

  it('keeps super-admin.routes.js a mount list, not a route file', () => {
    // The regrowth guard. If a new endpoint is appended here instead of to a
    // domain router, this fails and points at the right place to put it.
    const src = fs.readFileSync(ROOT, 'utf8');
    const inlineRoutes = [...src.matchAll(/^router\.(get|post|put|patch|delete)\(/gm)];
    expect(inlineRoutes.map((m) => m[0])).toEqual([]);
    expect(src.split('\n').length).toBeLessThan(80);
  });

  it('mounts every domain router that exists on disk', () => {
    // A file nobody mounts is invisible: its routes 404 while its code reads
    // as live. Cheap to leave behind during a rename.
    const onDisk = fs.readdirSync(DIR)
      .filter((f) => f.endsWith('.js') && f !== 'shared.js')
      .map((f) => f.replace(/\.js$/, ''))
      .sort();
    const src = fs.readFileSync(ROOT, 'utf8');
    const mounted = [...src.matchAll(/require\('\.\/super-admin\/([\w-]+)'\)/g)]
      .map((m) => m[1]).sort();
    expect(mounted).toEqual(onDisk);
  });

  it('keeps every domain router small enough to read', () => {
    // The point of H-03 was reviewability, not tidier filenames. 900 lines is
    // roughly twice the largest file the split produced, so this has headroom
    // for a domain to grow — but a file on its way back to 4,000 trips it.
    const oversized = fs.readdirSync(DIR)
      .filter((f) => f.endsWith('.js'))
      .map((f) => ({ f, n: fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').length }))
      .filter((x) => x.n > 900)
      .map((x) => `${x.f} (${x.n} lines)`);
    expect(oversized).toEqual([]);
  });

  it('every domain file exports an Express router', () => {
    for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.js') && x !== 'shared.js')) {
      const mod = require(path.join(DIR, f));
      expect(typeof mod).toBe('function');
      expect(Array.isArray(mod.stack)).toBe(true);
    }
  });
});
