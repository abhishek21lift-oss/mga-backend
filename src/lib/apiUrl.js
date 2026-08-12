'use strict';
// The API's own public base URL.
//
// frontendUrl.js answers "where does a person click"; this answers "where does
// a machine fetch". They are different hosts, and conflating them is how a
// tracking pixel ends up pointed at the Next.js app, which has no such route
// and returns an HTML 404 that renders as a broken image in the recipient's
// inbox.
//
// Order: an explicit override first, then the URL Render injects for the
// service itself. Returns null rather than guessing — a caller that cannot
// build an absolute URL should omit the feature (see the invitation email,
// which simply ships without a pixel) rather than emit a relative one that
// resolves against the mail client.

function apiBaseUrl(env = process.env) {
  const raw = env.PUBLIC_API_URL || env.API_BASE_URL || env.RENDER_EXTERNAL_URL || '';
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  // localhost is never reachable from a recipient's mail client. Better to
  // send no pixel than one that guarantees a broken image on every open.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(trimmed)) return null;
  return trimmed;
}

function apiUrl(path, env = process.env) {
  const base = apiBaseUrl(env);
  if (!base) return null;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

module.exports = { apiBaseUrl, apiUrl };
