// src/middleware/originCheck.js
// Defense-in-depth: reject API requests from unexpected origins.
// Mount AFTER CORS but BEFORE routes.
//
// This catches request smuggling, DNS rebinding, and cases where
// CORS preflight passes but the actual request should be blocked.
// It's safe because legitimate browsers always send Origin or Referer.

const logger = require('../lib/logger');

// Paths that must not be origin-checked.
//
// NOTE the leading segment: this middleware is mounted with app.use('/api/', …),
// and Express strips the mount path, so inside here req.path is '/health' — NOT
// '/api/health'. The previous check compared against '/api/health' and therefore
// never matched anything. It went unnoticed because Render's health probe sends
// no Origin or Referer and so exits on the line above.
const ORIGIN_EXEMPT = new Set([
  '/health',

  // Google's OAuth redirect. This is a top-level browser navigation FROM
  // accounts.google.com, so it arrives with a third-party Referer by
  // definition — an origin allowlist can only ever reject it, which is
  // exactly what happened: connecting a calendar died on {"error":"Forbidden"}.
  //
  // Exempting it does not weaken anything, because an origin check was never
  // this endpoint's protection. The CSRF defence is the signed `state` JWT
  // (verified with JWT_SECRET and required to carry purpose='calendar_oauth'),
  // and the authorization code is single-use and redeemed server-to-server
  // with Google. Both are checked in routes/calendar.js before any token is
  // stored.
  '/calendar/callback',
]);

// Prefixes rather than exact paths, for exempt routes that carry an id.
const ORIGIN_EXEMPT_PREFIXES = [
  // The invitation email's open-tracking pixel. It is fetched by a mail client
  // or an image proxy (Gmail's, Outlook's), never by our own frontend, so an
  // origin allowlist can only reject it — and whichever Referer those proxies
  // do send is not something we control or can enumerate.
  //
  // Exempting it gives nothing away: the URL carries an opaque track_id, not
  // the invitation token, and the only effect a request can have is flipping
  // one invitation from 'sent' to 'opened'. There is no state an attacker
  // would want and nothing to read back — the response is a 1x1 GIF either
  // way, including for ids that do not exist.
  '/invitations/track/',
];

function originCheck(req, res, next) {
  // Skip for server-to-server calls (no origin) and health checks
  if (!req.headers.origin && !req.headers.referer) return next();
  if (ORIGIN_EXEMPT.has(req.path)) return next();
  if (ORIGIN_EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next();

  try {
    const url = new URL(origin);
    const hostname = url.hostname;

    // Allow localhost in development
    if (hostname === 'localhost' || hostname === '127.0.0.1') return next();

    // Allow known frontend domains
    const allowedHosts = [
      ...(process.env.FRONTEND_URL ? [new URL(process.env.FRONTEND_URL).hostname] : []),
      ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(function(o) {
        try { return new URL(o.trim()).hostname; } catch { return null; }
      }).filter(Boolean) : []),
    ];

    if (allowedHosts.includes(hostname)) return next();

    logger.warn({ origin: origin, hostname: hostname, path: req.path }, 'Origin check failed');
    return res.status(403).json({ error: 'Forbidden' });
  } catch {
    // Invalid URL in origin/referer — just log and deny
    logger.warn({ origin: origin, path: req.path }, 'Invalid origin header');
    return res.status(400).json({ error: 'Invalid request' });
  }
}

module.exports = { originCheck };
