'use strict';

/**
 * FRONTEND_URL with any trailing slash removed.
 *
 * Every caller builds a path onto this base — `${base}/reset-password`,
 * `${base}/settings/integrations` — so a value stored as
 * "https://example.com/" (which is what you get if you paste the URL out of a
 * browser address bar, and is exactly how it is set in production today)
 * produces "https://example.com//reset-password". A doubled slash in a
 * password-reset link is the kind of thing that either 404s or silently
 * redirects depending on the host, and it is invisible until a real user
 * cannot get back into their account.
 *
 * Normalising here rather than asking every deployment to store the value
 * "correctly" — a trailing slash is not a mistake anyone should have to
 * remember not to make.
 *
 * Note this is only for building paths. CORS and originCheck already run the
 * value through `new URL()`, whose .origin and .hostname ignore trailing
 * slashes, so those were never affected.
 */
function frontendBase() {
  return String(process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
}

/** Absolute URL for a path on the frontend. `path` should start with "/". */
function frontendUrl(path = '') {
  const base = frontendBase();
  if (!path) return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

module.exports = { frontendBase, frontendUrl };
