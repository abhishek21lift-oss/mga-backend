#!/usr/bin/env node
'use strict';
/**
 * Enumerate every HTTP route the application actually registers.
 *
 * Read off the live Express app rather than parsed out of the source: a
 * regex over route files misses routes mounted conditionally, misses the
 * middleware stack that decides whether a route is authenticated, and drifts
 * the moment a router is refactored. Requiring the app and walking its router
 * stack asks the thing itself.
 *
 * Emits JSON so the IDOR suite can iterate the real surface instead of a
 * hand-kept list that silently stops matching.
 *
 * Usage: node scripts/route-inventory.js [--json]
 */

const path = require('node:path');

// The app needs these to be requireable at all; none is a real credential.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'route-inventory-not-a-real-secret-0000000';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable';
// Do not open queues, sockets or cron just to list routes.
process.env.RUN_WORKERS = '0';
process.env.COMMAND_CENTER_STREAM = 'off';
process.env.ROUTE_INVENTORY = '1';

/** Names of middleware that mark a route as requiring authentication. */
const AUTH_MW = new Set(['auth', 'authenticate', 'requireAuth', 'clientAuth', 'verifyToken']);
const ROLE_MW = /^(requireRole|requireStaff|requireClient|adminOnly|adminOrManager|adminManagerOrTrainer|requireSuperAdmin|requireSuperAdminMfa|requireTrainerOwnership)$/;

/** Platform-level prefixes: cross-tenant by design, not IDOR candidates. */
const PLATFORM_PREFIXES = ['/api/admin', '/api/platform', '/api/super-admin', '/api/registrations'];
/** Unauthenticated or identity-establishing surfaces. */
const PUBLIC_PREFIXES = ['/api/public', '/api/auth', '/api/client-login', '/api/client-activation', '/api/health', '/api/debug'];

function classify(routePath, mws) {
  if (mws.some((m) => /superAdmin/i.test(m))) return 'SUPER-ADMIN';
  if (PLATFORM_PREFIXES.some((p) => routePath.startsWith(p))) return 'PLATFORM';
  if (PUBLIC_PREFIXES.some((p) => routePath.startsWith(p))) return 'PUBLIC';
  if (routePath.startsWith('/api/exercises')) return 'SHARED';
  if (mws.some((m) => AUTH_MW.has(m))) return 'TENANT';
  return 'UNKNOWN';
}

function joinPath(prefix, layerPath) {
  const p = `${prefix}${layerPath}`.replace(/\/{2,}/g, '/');
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** Recover a mount prefix from an Express layer's regexp. */
function prefixOf(layer) {
  if (layer.path) return layer.path;
  const src = layer.regexp && layer.regexp.source;
  if (!src) return '';
  if (src === '^\\/?(?=\\/|$)') return '';
  const m = src.match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!m) return '';
  return '/' + m[1].replace(/\\\//g, '/').replace(/\\\./g, '.');
}

function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const routePath = joinPath(prefix, layer.route.path);
      const methods = Object.keys(layer.route.methods).filter((m) => m !== '_all').map((m) => m.toUpperCase());
      const mws = layer.route.stack.map((s) => s.name).filter(Boolean);
      const params = (routePath.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g) || []).map((s) => s.slice(1));
      for (const method of methods) {
        out.push({
          method,
          path: routePath,
          authenticated: mws.some((m) => AUTH_MW.has(m)),
          roleGuards: mws.filter((m) => ROLE_MW.test(m)),
          params,
          classification: classify(routePath, mws),
          middleware: mws,
        });
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, joinPath(prefix, prefixOf(layer)), out);
    }
  }
}

let app;
try {
  app = require(path.join(__dirname, '..', 'src', 'server.js'));
} catch (err) {
  console.error('could not require the app:', err.message);
  process.exit(2);
}

const router = app && (app._router || (app.router && app.router.stack ? app.router : null));
if (!router || !router.stack) {
  console.error('the app did not expose a router stack — is server.js exporting the express app?');
  process.exit(2);
}

const routes = [];
walk(router.stack, '', routes);
routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(routes, null, 2));
} else {
  const by = routes.reduce((acc, r) => { acc[r.classification] = (acc[r.classification] || 0) + 1; return acc; }, {});
  console.log(`routes: ${routes.length}`);
  for (const [k, v] of Object.entries(by).sort()) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log('');
  console.log('tenant-scoped routes taking an id parameter:');
  for (const r of routes.filter((x) => x.classification === 'TENANT' && x.params.length)) {
    console.log(`  ${r.method.padEnd(6)} ${r.path}`);
  }
}

// Nothing here should keep the process alive, but the app opens a pool.
setTimeout(() => process.exit(0), 50).unref();
