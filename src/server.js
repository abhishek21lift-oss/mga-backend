// src/server.js
// MY PT STUDIO API — consolidated v2 + v3 entry point
// ───────────────────────────────────────────────────
// STARTUP ENV CHECKS — fail fast with clear messages
// ───────────────────────────────────────────────────
// Initialise error monitoring before anything else so Sentry can
// auto-instrument Express/pg. No-op unless SENTRY_DSN is set.
const Sentry = require('./instrument');
require('dotenv').config();

const logger = require('./lib/logger');

// Define isProd early — used in env checks below and throughout the file
const isProd = (process.env.NODE_ENV || 'development') === 'production';

const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'FRONTEND_URL'];
const missing = REQUIRED_ENV.filter(function(k) { return !process.env[k]; });
if (missing.length) {
  logger.fatal({ missing }, 'Missing required environment variables');
  console.error('  Set them in your .env file or your Render dashboard.');
  process.exit(1);
}

if (process.env.JWT_SECRET.length < 32) {
  logger.fatal('JWT_SECRET is too short (minimum 32 characters). Use a strong random secret (96 hex chars recommended).');
  process.exit(1);
}

// Warn about missing recommended (non-fatal) vars so ops teams notice early.
// SUPABASE_URL / SUPABASE_SERVICE_KEY were removed from this list: no code
// path reads either one (the app reaches Postgres solely via DATABASE_URL +
// pg), so warning about them only pushed operators to provision a
// service_role key — which bypasses RLS entirely — that nothing consumes.
const RECOMMENDED_ENV = [
  'RP_ID',
  'WEBAUTHN_ORIGIN',
];
const missingRecommended = RECOMMENDED_ENV.filter(function(k) { return !process.env[k]; });
if (missingRecommended.length) {
  logger.warn({ missing: missingRecommended }, 'Recommended env vars not set — some features may be degraded');
}

// ── Email (SMTP) ────────────────────────────────────────────────────────────
// lib/email.js sends nothing at all unless SMTP_HOST, SMTP_USER and SMTP_PASS
// are ALL set. The reason that deserves a boot-time announcement rather than a
// line in a runbook is that it is invisible from every other angle: the
// service starts clean, passes its health check, serves every request, and
// silently drops admin invitations, password-reset links and the Control
// Centre's "email them a link". /auth/forgot-password even answers "if the
// email exists, a reset link has been sent" — it must not reveal whether an
// address is registered — so the first symptom is a person who cannot get
// back into their account and no log line explaining why.
//
// Warned, never fatal — deliberately unlike the R2 check below. R2 silently
// destroys uploaded files, so refusing to boot is the lesser harm. Email being
// down does not lose data: check-ins, billing and client management all work
// fine without it. Taking the whole platform offline over a mail typo would be
// a bigger outage than the one it prevents.
const emailConfig = require('./lib/email').describeConfig();
if (emailConfig.state === 'partial') {
  // Always an outright mistake — somebody set some of them and stopped.
  logger.error(
    { set: emailConfig.set, missing: emailConfig.missing },
    'SMTP is PARTIALLY configured, so no email will be sent at all. '
    + 'Invitations, password resets and set-password links will fail silently. '
    + 'Set all three, or none.'
  );
} else if (emailConfig.state === 'absent') {
  // In development this is the ordinary case and only worth a note. In
  // production it means password recovery does not work for anyone.
  const log = isProd ? logger.error : logger.warn;
  log.call(
    logger,
    { missing: emailConfig.missing },
    isProd
      ? 'SMTP is not configured in production — nobody can recover a password '
        + 'and no invitation will arrive. Verify with `npm run verify:smtp <address>`.'
      : 'SMTP is not configured — outgoing email is disabled (normal in local development).'
  );
}

// Having all three variables set only means something was typed into them. It
// does not mean the host answers, the mailbox exists, or the password is
// right — and nothing downstream will tell you, because every failure on the
// password-reset path is invisible by design: the endpoint must answer the
// same whether or not an address is registered, so a dead mailbox looks
// exactly like a working one until somebody reports a missing email.
//
// So the credentials are proved at boot, once, and the answer goes in the
// deploy log whether or not anyone thinks to look. Nothing is sent — this is
// an SMTP handshake and AUTH, no message.
//
// Non-fatal, and deliberately not awaited: mail being misconfigured must not
// stop a studio taking check-ins, and the port must not wait on a network
// round-trip to a third party.
if (emailConfig.state === 'configured') {
  require('./lib/email').verifyConnection()
    .then(function(r) {
      if (r.ok) {
        logger.info({ host: r.host, port: r.port, user: r.user, from: r.from },
          'SMTP verified at boot — credentials accepted, outgoing email should work');
      } else {
        logger.error(
          { reason: r.reason, err: r.message, response: r.response, diagnosis: r.diagnosis,
            host: r.host, port: r.port, user: r.user, from: r.from },
          'SMTP FAILED verification at boot — password resets and invitations will NOT arrive'
        );
      }
    })
    .catch(function(err) {
      logger.error({ err: err.message }, 'SMTP boot verification could not run');
    });
}

// ── Cloudflare R2 object storage ────────────────────────────────────────────
// lib/fileStorage.js falls back to local disk whenever R2 is not fully
// configured. On Render the filesystem is ephemeral, so that fallback silently
// destroys every uploaded file — signed consent PDFs, PAR-Q forms, avatars —
// on the next deploy or restart, with nothing in the logs to show for it.
//
// Partial configuration is always a mistake, so it is fatal in every
// environment. A complete absence of R2 config is fatal in production only,
// where the ephemeral-disk fallback is never the intended behaviour; local dev
// keeps working on disk untouched.
const R2_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const r2Set = R2_VARS.filter(function(k) { return Boolean(process.env[k]); });

if (r2Set.length > 0 && r2Set.length < R2_VARS.length) {
  logger.fatal(
    { set: r2Set, missing: R2_VARS.filter(function(k) { return !process.env[k]; }) },
    'R2 object storage is partially configured — uploads would silently fall back to ephemeral local disk. Set all three R2 variables, or none.'
  );
  process.exit(1);
}

if (isProd && r2Set.length === 0) {
  logger.fatal(
    { required: R2_VARS },
    'R2 object storage is not configured in production — uploaded consent PDFs, PAR-Q forms and avatars would be written to ephemeral disk and lost on every deploy.'
  );
  process.exit(1);
}

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit     = require('express-rate-limit');
const { makeStore } = require('./lib/rateLimitStore');
const cookieParser  = require('cookie-parser');

const { errorHandler, notFound } = require('./middleware/errorHandler');
const { auth, adminOnly }        = require('./middleware/auth');
const { requireStaff, requireClient } = require('./middleware/rbac');
const { requireSuperAdmin, requireSuperAdminMfa } = require('./middleware/tenant');
const { branchScope }            = require('./middleware/branch-scope');
const { requireFeature }         = require('./lib/features');
const { requireAiQuota }         = require('./lib/aiQuota');

// Feature gating for tenant-facing routers.
//
// requireFeature() reads req.user, so it MUST run after auth — mounted before
// it, the guard sees no user and returns next(), enforcing nothing while
// looking wired. Most routers apply auth per-route rather than globally, so
// the gate brings its own. auth is stateless (verify token, load user) and
// safe to run twice.
//
// Only non-core, sellable capabilities are gated. Deliberately NOT gated:
// auth, subscription and payments (a studio must always be able to sign in
// and pay, whatever else is switched off), clients and sessions (is_core in
// the registry, never disableable), and anything whose feature key does not
// map cleanly to a whole mount.
//
// Every feature currently seeds default_enabled = true with no plan gating,
// so this changes nothing for anyone until an operator turns something off in
// the Control Centre — which is the point of the toggle existing.
const gate = (key) => [auth, requireFeature(key)];

const app  = express();
const PORT = Number(process.env.PORT) || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Behind Render / Vercel / Cloudflare — trust the proxy hops in front of us so
// req.ip is the real client and rate-limit keys aren't bucketed to one IP.
//
// The correct value is the NUMBER OF PROXIES in front of this process, and it
// depends on the deployment topology: Render alone is 1, Cloudflare in front of
// Render is 2. Setting it too low makes req.ip an infrastructure address, which
// collapses every caller into a single rate-limit bucket and neuters the login
// brute-force protection below. Overridable so the value can match the actual
// topology without a code change; verify by logging req.ip in production and
// confirming it matches real client addresses.
const TRUST_PROXY = (() => {
  const raw = (process.env.TRUST_PROXY || '').trim();
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : raw; // number of hops, or an express-compatible string
})();
app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');

// ────────────────────────
// SECURITY
// ────────────────────────
app.use(helmet({
  // H-01: strict CSP for a JSON API (no scripts/styles served here)
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'none'"],
      scriptSrc:      ["'none'"],
      styleSrc:       ["'none'"],
      imgSrc:         ["'self'"],
      connectSrc:     ["'self'"],
      frameAncestors: ["'none'"],
      formAction:     ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// ────────────────────────
// CORS
// ────────────────────────
function validOrigin(origin) {
  if (!origin) return null;
  const trimmed = origin.trim();
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
    return url.origin;
  } catch {
    logger.warn({ origin: trimmed }, 'Ignoring invalid CORS origin');
    return null;
  }
}

const allowedOrigins = [
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(validOrigin) : []),
  validOrigin(process.env.FRONTEND_URL),
  // M-04: localhost only allowed in development — not in production builds
  ...(!isProd ? ['http://localhost:3000', 'http://127.0.0.1:3000'] : []),
].filter(Boolean);

app.use(cors({
  origin: function(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    logger.warn({ origin }, 'CORS blocked origin');
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  // x-org-id lets a platform super_admin scope requests to one tenant org
  // (the org-switcher). It is ignored for every non-super_admin (tenant users
  // are always locked to their JWT org — see lib/tenant-db.js), so allowing it
  // through CORS cannot widen any tenant user's access.
  allowedHeaders: ['Content-Type', 'Authorization', 'x-org-id'],
}));

// ────────────────────────
// RAZORPAY WEBHOOK (raw body — must be before json middleware)
// ────────────────────────
// H-06: route registers its own express.raw() parser so signature can be verified
app.use('/api/webhooks/razorpay', require('./routes/razorpay-webhook'));

// ────────────────────────
// BODY PARSING
// ────────────────────────
// ── The three endpoints that carry an image inside JSON ─────────────────────
//
// 100kb is the right default and stays the default. But three endpoints take a
// base64 data URL in the body, and base64 inflates bytes by a third:
//
//   POST /api/pt-os/clients/:id/photo        the client's profile photo
//   POST /api/progress/progress-photos       progress photos
//   POST /api/pt-os/informed-consent/:id/sign  the signature image
//
// The client photo is cropped and re-encoded browser-side to 800px JPEG at
// q0.8 before it is sent, which sounds small and is not. Measured in Chromium
// on an 800x800 canvas, as the JSON body actually posted:
//
//   smooth gradient   14 KB     (best case for JPEG)
//   detailed / noisy  529 KB    (worst case)
//
// A photograph of a person — hair, skin texture, a background — sits near the
// noisy end. So this limit rejected the request with 413 before the route ran,
// and it had done so since the feature shipped: the new-client flow posts to
// the same endpoint, which is why no client in the database has a photo.
//
// Raised only for these paths, matched exactly. Everything else keeps 100kb.
const imageJson = express.json({ limit: '4mb' });
const IMAGE_JSON_PATHS = [
  /^\/api\/pt-os\/clients\/[^/]+\/photo$/,
  /^\/api\/progress\/progress-photos$/,
  /^\/api\/pt-os\/informed-consent\/[^/]+\/sign$/,
];
app.use((req, res, next) => (
  req.method === 'POST' && IMAGE_JSON_PATHS.some((re) => re.test(req.path))
    ? imageJson(req, res, next)
    : next()
));

// L-06: 100kb default for everything else
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());
app.use('/uploads', require('./routes/uploads'));

// ────────────────────────
// ORIGIN / REFERER CHECK (defense-in-depth)
// ────────────────────────
const { originCheck } = require('./middleware/originCheck');
app.use('/api/', originCheck);

// ────────────────────────
// FIRST-PARTY SERVICE ATTESTATION
// ────────────────────────
// The AI service (repo: mps-ai) relays the end user's own token and adds
// X-Service-Auth to attest that the relay was it. Mounted here — after
// originCheck, before auth — so a forged attestation is refused before any
// user lookup or database work happens.
//
// It grants NOTHING: `auth` still resolves the user and tenantScope still
// filters. Requests without the header — every browser — pass straight through.
const { serviceAuth } = require('./middleware/serviceAuth');
app.use('/api/', serviceAuth);

// ────────────────────────
// INPUT SANITIZATION
// ────────────────────────
const { sanitizeBody, sanitizeQuery } = require('./middleware/sanitize');
app.use(sanitizeBody);
app.use(sanitizeQuery);

// ────────────────────────
// REQUEST ID
// ────────────────────────
const requestId = require('./middleware/requestId');
app.use(requestId);

// ────────────────────────
// STRUCTURED REQUEST LOGGER
// ────────────────────────
const httpMetrics = require('./modules/command-center/httpMetrics');

app.use(function(req, res, next) {
  const start = Date.now();
  res.on('finish', function() {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api/')) {
      // Feed the Command Center's latency ring from the timing that already
      // happens here rather than adding a second middleware doing the same
      // work — two timers would double the cost and could disagree with these
      // logs the moment someone edits one of them.
      //
      // req.route?.path is the MATCHED route ('/:id'), so the key is
      // '/api/clients/:id' and not a distinct endpoint per client id. Falls
      // back to the raw path for 404s, which have no matched route. Never
      // allowed to break the response.
      try {
        const matched = req.route?.path
          ? `${req.baseUrl || ''}${req.route.path}`
          : req.path;
        httpMetrics.record(req.method, matched, res.statusCode, ms);
      } catch { /* metrics must never affect a response */ }

      logger.info({
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        ms: ms,
        req_id: req.id,
        query: Object.keys(req.query).length ? req.query : undefined,
      }, '%s %s %d %dms', req.method, req.originalUrl, res.statusCode, ms);
    }
  });
  next();
});

// ────────────────────────
// HEALTH CHECK
// ────────────────────────
app.get('/', function(req, res) {
  res.json({ status: 'ok', app: 'MY PT STUDIO API', version: '3.0.0' });
});

app.get('/api/health', async function(req, res) {
  const { sendHealthResponse } = require('./lib/health');
  return sendHealthResponse(req, res);
});



// ────────────────────────
// RATE LIMITING
// ────────────────────────
// Global IP-based limiter (catches unauthenticated traffic)
const apiLimiter = rateLimit({
  store: makeStore('api'),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: isProd ? 2000 : 5000,
  standardHeaders: true,
  legacyHeaders: false,
});

// M-05: per-user limiter applied after auth so shared IPs don't block each other
const userApiLimiter = rateLimit({
  store: makeStore('user'),
  passOnStoreError: true,
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip,
  skip: (req) => !req.user,
  message: { error: 'Too many requests. Please slow down.' },
});

const loginLimiter = rateLimit({
  store: makeStore('login'),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
});

const registerLimiter = rateLimit({
  store: makeStore('register'),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many account creation attempts. Please wait 15 minutes.' },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login',          loginLimiter);
app.use('/api/v1/auth/login',       loginLimiter);
app.use('/api/auth/google-login',   loginLimiter);
app.use('/api/v1/auth/google-login',loginLimiter);
app.use('/api/v1/auth/forgot-password', registerLimiter);
app.use('/api/v1/auth/reset-password',  registerLimiter);
app.use('/api/auth/create-user', registerLimiter);
app.use('/api/auth/users',      registerLimiter);
app.use('/api/auth/forgot-password', registerLimiter);
app.use('/api/auth/reset-password',  registerLimiter);
app.use('/api/v1/auth/refresh',      loginLimiter);
app.use('/api/auth/refresh',         loginLimiter);

// ────────────────────────
// BRANCH SCOPE (ISSUE-004)
// Must run AFTER auth middleware (so req.user is set) but BEFORE route handlers.
// branchScope is safe to apply globally — it is a no-op when req.user is absent
// or when the user has no branch_id (single-branch / legacy installs).
// TODO: downstream route handlers should append req.branchScope.sql / params to
//       multi-branch-aware queries once branch_id columns are fully populated.
// ────────────────────────
app.use('/api/', branchScope);

// ────────────────────────
// v2 ROUTES (production)
// ────────────────────────

// ROUTE INTEGRITY NOTE (R-01):
// /api/auth and /api/v1/auth both mount the same router intentionally.
// /api/v1/auth exists for legacy mobile app callers. Any changes to auth
// behaviour must be tested against both URL prefixes.
// Unauthenticated marketing data (plan catalogue + platform aggregates) for the
// public landing page. Aggregate-only — no per-tenant values are exposed.
app.use('/api/public',            require('./routes/public'));

// Public by design: an invited admin has no password yet, so nothing here can
// require one. The single-use hashed token IS the credential — see
// routes/invitations.js for why every rejection returns the same shape.
app.use('/api/invitations',       require('./routes/invitations'));
// Public for the same reason: a client activating their login has no password
// yet. The single-use hashed token IS the credential — see
// routes/client-activation.js, which holds every rejection to one shape.
app.use('/api/client-activation', require('./routes/client-activation'));
// Self-serve trial signup. Deliberately unauthenticated: the whole point is
// that the applicant does not have an account yet.
app.use('/api/registrations',     require('./routes/registrations'));
app.use('/api/auth',              require('./routes/auth'));
app.use('/api/auth',              require('./routes/auth-google'));
app.use('/api/auth/webauthn',     require('./routes/auth-webauthn'));
app.use('/api/v1/auth',           require('./routes/auth'));
app.use('/api/v1/auth',           require('./routes/auth-google'));
app.use('/api/v1/auth/webauthn',  require('./routes/auth-webauthn'));
app.use('/api/profile',           require('./routes/profile'));
// Read-only: the caller's own studio's feature flags. Additive — nothing that
// existed before this route consults it (see lib/features.js).
app.use('/api/features',          require('./routes/features'));
// The studio's side of support. Scoped to the caller's own organization with
// no request-controlled org parameter; internal operator notes are excluded by
// lib/support.TENANT_MESSAGE_SQL. Deliberately NOT feature-gated — a studio
// must always be able to reach us, whatever else is switched off.
app.use('/api/support',           require('./routes/support'));
app.use('/api/subscription',      require('./routes/subscription'));
// Global top-nav search. Carries its own rate limiter (see routes/search.js),
// so it is deliberately NOT wrapped in userApiLimiter — debounced typing would
// otherwise consume the shared per-user budget that real API calls need.
app.use('/api/search',            require('./routes/search'));

// ONE router, deliberately. This mount used to carry a second file,
// routes/client-actions.js, whose thirteen endpoints read and wrote the legacy
// `clients` table — a table with no organization_id column, so nothing mounted
// on it could be tenant-scoped at all. It was unreachable in practice (the
// table is empty, so every handler 404'd, and two of the tables it wrote to no
// longer exist) and nothing called it, but "unreachable" was an accident of
// there being no rows rather than a property of the code. Deleted; the
// org-scoped equivalents live under /api/pt-os/clients.
// See src/__tests__/clients.legacy-table.test.js, which fails if anything
// mounted here starts reading that table again.
app.use('/api/clients',           userApiLimiter, require('./routes/clients'));

app.use('/api/trainers',          require('./routes/trainers'));
// Manual UTR verification payments. MUST be mounted before the finance ledger
// router below: that one owns DELETE /:id and a bare /:id would otherwise
// swallow /api/payments/upi/... before this router ever sees it.
app.use('/api/payments/upi',      userApiLimiter, require('./routes/upi-payments'));
app.use('/api/payments',          userApiLimiter, require('./routes/payments'));
app.use('/api/attendance',        ...gate('attendance'), require('./routes/attendance'));

// ROUTE INTEGRITY NOTE (R-03) — SUPERSEDED, and deliberately reversed.
//
// This note used to read: "New pages should use /api/v1/reports. Do not add
// endpoints to the legacy router — it will be removed once all consumers are
// migrated." That direction is no longer correct and following it would be a
// tenant-isolation regression, so /api/v1/reports has been deleted and THIS
// router is the one to build on.
//
// What changed is that the v3 model underneath /api/v1/reports was abandoned.
// It read members, payments and member_memberships; all three are empty, none
// has an organization_id column, and modules/reports carried no tenant filter
// of any kind — `GET /api/v1/reports/revenue` was `FROM payments p WHERE
// p.deleted_at IS NULL` behind auth + admin/manager, i.e. every studio's
// revenue to any studio's admin. This router scopes every query (see orgParam)
// and reads the clients / pt_* tables the product actually writes to.
//
// So "legacy" had it backwards: /api/reports is the tenant-safe, live
// implementation, and the migration target was the unsafe one. Do not
// reintroduce a v1 reports router without organization_id on its tables.
app.use('/api/reports',           userApiLimiter, ...gate('insights'), require('./routes/reports'));

app.use('/api/plans',             ...gate('packages'), require('./routes/plans'));
app.use('/api/leave',             require('./routes/leave'));
app.use('/api/expenses',          ...gate('finance'), require('./routes/expenses'));

// ROUTE INTEGRITY NOTE (R-03 / bookings):
// /api/bookings and /api/v1/bookings both mount the same router.
// Same policy as auth: legacy callers use /api/bookings, new callers use /api/v1/bookings.
app.use('/api/v1/bookings',       require('./modules/bookings/bookings.routes'));
app.use('/api/bookings',          require('./modules/bookings/bookings.routes'));

// FIX (Route Integrity R-10, tightened by audit finding C-1):
// /api/admin previously relied solely on individual route handlers to apply
// auth + adminOnly middleware. This left the mount unguarded — any handler
// that forgot to include the middleware chain would be publicly accessible.
// We enforce auth at the mount level as defense-in-depth. Individual handlers
// may still include their own middleware; it is a no-op.
//
// C-1: admin-reset.js performs platform-wide, unscoped destructive operations
// (DELETE/DROP across every tenant's data, no organization_id filter — these
// are irreversible bulk-wipe tools, not ordinary tenant-admin actions). Gating
// them behind `adminOnly` (role==='admin', the ordinary Studio Owner role
// auto-granted to every self-serve trial signup) let any trial signup wipe
// every tenant on the platform. This must be `requireSuperAdmin` +
// `requireSuperAdminMfa`, matching every other platform-destructive route.
app.use('/api/admin',             auth, requireSuperAdmin, requireSuperAdminMfa, require('./routes/admin-reset'));
app.use('/api/debug',             auth, adminOnly, require('./routes/debug'));

// Platform Super Admin portal (multi-tenant SaaS). Guarded at the mount with
// auth + requireSuperAdmin — inaccessible to tenant admins and everyone else.
app.use('/api/super-admin',       auth, requireSuperAdmin, requireSuperAdminMfa, require('./modules/platform/super-admin.routes'));

app.use('/api/modules',           require('./modules/operations/operations.routes'));

// ────────────────────────
// PREMIUM FEATURE ROUTES (v4)
// ────────────────────────
app.use('/api/calendar',          require('./routes/calendar'));
app.use('/api/qr',               ...gate('attendance'), require('./routes/qr-checkin'));
app.use('/api/settings',          require('./routes/settings'));
app.use('/api/invoices',          ...gate('finance'), require('./routes/invoices'));
app.use('/api/workouts',          ...gate('programs'), require('./routes/workouts'));
// The Exercise Library. Sits behind the same 'programs' feature as the Workout
// Builder it feeds — a studio with programmes always has the library, and one
// without it has no use for either.
app.use('/api/exercises',         ...gate('programs'), require('./routes/exercises'));
app.use('/api/diet',              require('./routes/diet'));
// '/api/biometric-attend' and '/api/webauthn' were mounted here: a second
// check-in path (fingerprint / GPS) writing the same attendance_logs rows as
// '/api/qr' above, plus the member fingerprint enrolment behind it. Check-in
// is QR only now. Note that '/api/auth/webauthn' — staff passkey LOGIN — is a
// different system and is still mounted above.
app.use('/api/integrations',      ...gate('integrations'), require('./routes/integrations'));
app.use('/api/campaigns',         ...gate('communication'), require('./routes/campaigns'));
app.use('/api/offers',            require('./routes/offers'));
app.use('/api/feedback',          require('./routes/feedback'));
app.use('/api/communication',     ...gate('communication'), require('./routes/communication'));
// Mounted before /api/ai so /api/ai/knowledge/* is matched here first,
// regardless of what routes/ai.js's own router does internally.
// The AI mounts additionally carry a token-quota guard. It runs AFTER the
// feature gate (a disabled feature should say "not enabled", not "over
// quota") and refuses only when an operator has switched enforcement on AND
// the studio is over its monthly allowance. Enforcement ships OFF, and the
// guard fails open if the check itself errors — a cost control must not be
// able to take the AI Suite down. See lib/aiQuota.js.
app.use('/api/ai/knowledge',      userApiLimiter, ...gate('ai_knowledge_base'), requireAiQuota(), require('./routes/aiKnowledge'));
// Executable actions. Mounted BEFORE routes/ai so /api/ai/actions/* is not
// swallowed by anything there, and deliberately outside requireAiQuota():
// these endpoints run no model. Confirming a WhatsApp send must not fail
// because the studio is over its token allowance for the month.
app.use('/api/ai',               userApiLimiter, ...gate('ai_suite'), require('./modules/ai-actions/ai-actions.routes'));
app.use('/api/ai',               ...gate('ai_suite'), requireAiQuota(), require('./routes/ai'));

// ────────────────────────
// MEMBER PORTAL ROUTES
// ────────────────────────
app.use('/api/classes',           require('./routes/classes'));

// ────────────────────────
// PT OS — Personal Training Operating System
// ────────────────────────
// The back office, and gated as such at the MOUNT rather than per route.
//
// Every handler inside already calls auth(); the pair here runs first so the
// role check cannot be forgotten on a route added later — which is exactly how
// the gap this closes came about. Read routes here were `auth`-only, harmless
// only for as long as no account held the `member` role. Client logins end
// that, and an ungated GET /api/pt-os/clients hands a client the studio's
// whole client list. See requireStaff in middleware/rbac.js.
//
// auth() running twice is cheap: the second call is a user-cache hit.
// A client's own data is served by /api/me, which scopes to the caller.
app.use('/api/pt-os',            auth, requireStaff, require('./modules/pt-os/pt-os.routes'));
app.use('/api/pt-os',            auth, requireStaff, require('./modules/pt-os/parq.routes'));
app.use('/api/pt-os',            auth, requireStaff, require('./modules/pt-os/informed-consent.routes'));
app.use('/api/pt-os',            auth, requireStaff, require('./modules/pt-os/workout-log.routes'));

// The client's own surfaces. Mirror image of the block above: requireClient
// refuses anyone who is not a `member` linked to a client record, and every
// query inside is scoped to req.user.pt_client_id — never to an id from the
// request.
app.use('/api/me',               auth, requireClient, require('./modules/client-portal/client-portal.routes'));

// Trainer-side control of client logins. Staff only, org-scoped.
app.use('/api/client-login',     auth, requireStaff, require('./routes/client-login'));

// ────────────────────────
// BUSINESS FLOW ROUTES (v4 — Progress, Automation)
// ────────────────────────
app.use('/api/progress',         require('./modules/progress/progress.routes'));
app.use('/api/automation',       require('./modules/automation/automation.routes'));

// ────────────────────────
// v3 MODULE ROUTES
// ────────────────────────
//
// /api/v1/pt-sessions and /api/v1/reports were removed along with
// modules/sessions and modules/reports. Both were unreachable from the client
// and duplicated live implementations (/api/pt-os/sessions and /api/reports),
// but the reason they had to go rather than be left alone is tenant isolation:
// neither carried any. `GET /api/v1/reports/revenue` was auth + admin/manager
// with `FROM payments p WHERE p.deleted_at IS NULL` and no organization filter,
// so any studio's admin could read every studio's revenue. routes/reports.js,
// which the client actually calls, scopes every query.
//
// They were harmless in practice only because they read the abandoned v3
// tables — members, payments and member_memberships are all empty, and none of
// the three even has an organization_id column to filter on. That is precisely
// what made them dangerous to keep: the day anyone populated those tables, five
// endpoints would have started serving cross-tenant data with no code change
// and nothing to notice it. They cannot be fixed in place without a schema
// change to tables holding no data, so deleting them is the honest option.
//
// /api/v1/members has now gone the same way, for the same reason and after the
// same check. It was kept because the client appeared to call two of its
// routes; both were dead — defined in the frontend's api barrel and invoked
// from nowhere. A read-only count against production returned 0 rows, 0
// organisations represented, 0 attributable rows, 0 duplicate member codes.
// See src/db/migrations/MEMBERS-TENANT-GAP.md for the audit and the decision.
//
// The members TABLE is deliberately untouched: workers/renewal.worker.js still
// joins it, member_memberships still has a foreign key to it, and dropping a
// table was never part of this.
//
// /api/v1/notifications stays — it backs the notification bell and has a live
// caller.
app.use('/api/v1/notifications',  require('./modules/notifications/notifications.routes'));

// ────────────────────────
// 404 + GLOBAL ERROR HANDLER
// ────────────────────────
app.use(notFound);
// Report unhandled route errors to Sentry (no-op unless SENTRY_DSN set) before
// the JSON error handler formats the response.
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);

// ────────────────────────
// START — run migrations first, then listen
// ────────────────────────
const { runMigrationsWithRetry } = require('./db/migrate');

logger.info('Running database migrations…');
runMigrationsWithRetry()
  .then(function() {
    // Start polling the operator's AI model overrides. After migrations, so
    // the table is guaranteed to exist; before listen, so the first request
    // has a warm cache. It cannot fail the boot — an unreachable table just
    // leaves the cache empty, which means "use the environment variables",
    // which is what every deploy does anyway until an operator sets one.
    require('./lib/ai/settings').start();

    // ── Background workers (BullMQ, in-process) ───────────────────────────────
    // Single-instance deploys (Render) run the queue workers inside the API
    // process instead of a second service: when Redis is configured, producer
    // queues enqueue email/whatsapp/AI/notification work and these workers
    // drain them on this same process. Set RUN_WORKERS=0 to keep workers in a
    // separate process (see the "worker" script in package.json). Without
    // Redis everything degrades to the pre-queue inline paths and this is a
    // no-op, so dev machines and test runs are unaffected.
    let workers = [];
    if (process.env.RUN_WORKERS !== '0') {
      const { startWorkers } = require('./workers');
      startWorkers()
        .then((ws) => { workers = ws; })
        .catch((err) => logger.warn({ err: err.message }, 'in-process workers failed to start — falling back to inline sends'));
    }

    const server = app.listen(PORT, '0.0.0.0', function() {
      logger.info({
        port: PORT,
        env: NODE_ENV,
        corsOrigins: allowedOrigins.length ? allowedOrigins : '(server-to-server only)',
      }, 'MY PT STUDIO API listening on port %d (%s)', PORT, NODE_ENV);
    });

    // ── Command Center realtime stream (Phase 3) ──────────────────────────
    //
    // Attached to the http.Server, not to Express: an Upgrade is an event on
    // the server and never enters the middleware stack, so `auth` cannot see
    // it. The socket is authenticated by a single-use ticket minted over the
    // already-authenticated HTTPS channel instead — the browser addresses
    // api.myptstudio.com directly here (the frontend's Next.js rewrite cannot
    // carry an Upgrade) and the session cookie belongs to myptstudio.com.
    // See modules/command-center/tickets.js for the alternatives and why.
    //
    // Nothing degrades when this is off: the console falls back to polling the
    // same snapshot endpoint, which is what it did before Phase 3.
    // Disable with COMMAND_CENTER_STREAM=off.
    let commandCenterStream = null;
    if (process.env.COMMAND_CENTER_STREAM !== 'off') {
      commandCenterStream = require('./modules/command-center/stream');
      commandCenterStream.attach(server, { allowedOrigins });
    }

    // Keepalive — a leftover from a sleep-on-idle host, INERT on this VPS.
    //
    // The containers run under `restart: unless-stopped` and nothing spins them
    // down, so there is nothing to keep awake. It stays because a future
    // deployment might sleep again and because ripping out a working feature is
    // not a cleanup; it is disabled simply by leaving KEEPALIVE_URL unset,
    // which is the state on this box.
    //
    // The message below used to say the service "will sleep after 15 minutes
    // idle" whenever the variable was absent. On a VPS that is false, and it is
    // exactly the kind of line that sends someone chasing a problem that does
    // not exist — so it now states what is true and leaves the judgement open.
    if (isProd) {
      const { resolveKeepalive, isWithinActiveHours } = require('./lib/keepalive');
      const PING_INTERVAL_MS = 14 * 60 * 1000;
      const ka = resolveKeepalive(process.env);

      if (!ka.url) {
        logger.info(
          'Keepalive not configured (no KEEPALIVE_URL). Expected on a VPS, where the '
          + 'containers do not sleep; only set this if the app is ever moved to a host '
          + 'that spins down when idle.'
        );
      } else {
        setInterval(() => {
          if (!isWithinActiveHours(new Date(), ka)) return;
          fetch(ka.url).catch(() => {});
        }, PING_INTERVAL_MS).unref();
        logger.info(
          { url: ka.url, activeHours: `${ka.startHour}:00–${ka.endHour}:00 ${ka.timeZone}`, interval: '14min' },
          'Uptime keepalive enabled'
        );
      }
    }

    // AI knowledge-base embedding warmup: the local embedding model
    // (@xenova/transformers) downloads its weights from Hugging Face on
    // first use, which is slow and — in network-restricted environments —
    // can fail outright. Doing that on server boot rather than on the first
    // real document upload surfaces a broken/blocked download in the logs
    // immediately instead of as a confusing "upload succeeded, indexing
    // failed" for whichever user happens to try it first. Non-fatal either
    // way: a failure here just means documents will show status='failed'
    // until it's fixed, not that the server won't start.
    if (process.env.AI_EMBEDDING_WARMUP !== 'off') {
      require('./lib/ai/embeddings').embedText('warmup').then(
        () => logger.info('AI embedding model ready'),
        (err) => logger.warn({ err: err.message }, 'AI embedding model warmup failed — document indexing will error until this is resolved')
      );
    }

    // Subscription sweep: freeze lapsed trials/subscriptions + send 7/3/1/expiry
    // reminders. Idempotent + de-duplicated, so a simple interval is safe (and
    // freezing is also enforced lazily on every request, independent of this).
    // Disable with SUBSCRIPTION_SWEEP=off.
    if (process.env.SUBSCRIPTION_SWEEP !== 'off') {
      const { runSubscriptionSweep } = require('./workers/subscription.worker');
      setTimeout(() => { runSubscriptionSweep(); }, 60 * 1000).unref();
      setInterval(() => { runSubscriptionSweep(); }, 6 * 60 * 60 * 1000).unref();
      logger.info({ interval: '6h' }, 'Subscription sweep scheduled');
    }

    // Scheduled platform announcements. Each send is guarded by its own row
    // lock and status check (lib/announcements.js), so an overlapping tick
    // cannot deliver twice — which is what makes a plain interval safe here.
    // The minute-level granularity matches the UI, which schedules to the
    // minute. Disable with ANNOUNCEMENT_DISPATCH=off.
    if (process.env.ANNOUNCEMENT_DISPATCH !== 'off') {
      const { dispatchDue } = require('./lib/announcements');
      const poolRef = require('./db/pool');
      const tick = () => dispatchDue(poolRef)
        .then((n) => { if (n) logger.info({ sent: n }, 'Scheduled announcements dispatched'); })
        .catch((err) => logger.warn({ err: err.message }, 'Announcement dispatch failed'));
      setTimeout(tick, 45 * 1000).unref();
      setInterval(tick, 60 * 1000).unref();
      logger.info({ interval: '60s' }, 'Announcement dispatcher scheduled');
    }

    // UPI order expiry: close orders nobody ever paid so they stop occupying
    // the one-open-order-per-plan slot and cluttering the member's history.
    // Only touches CREATED/PAYMENT_PENDING — an order awaiting the studio's
    // verification is never expired out from under the admin.
    // Disable with UPI_EXPIRY_SWEEP=off.
    if (process.env.UPI_EXPIRY_SWEEP !== 'off') {
      const { expireStaleOrders } = require('./lib/upiPayments');
      const { expireStaleRequests } = require('./lib/subscriptionCheckout');
      const sweep = () => Promise.all([
        expireStaleOrders()
          .then((n) => { if (n) logger.info({ expired: n }, 'UPI member orders expired'); }),
        expireStaleRequests()
          .then((n) => { if (n) logger.info({ expired: n }, 'Subscription checkouts expired'); }),
      ]).catch((err) => logger.warn({ err: err.message }, 'UPI expiry sweep failed'));
      setTimeout(sweep, 90 * 1000).unref();
      setInterval(sweep, 15 * 60 * 1000).unref();
      logger.info({ interval: '15min' }, 'UPI expiry sweeps scheduled');
    }

    // Command Center log persistence (D4). The ring buffer needs no scheduling
    // — it is filled synchronously by the logger — but the critical lines it
    // queues are written in batches, and the table needs a retention sweep or
    // it grows forever.
    //
    // Deliberately NOT wrapped in a logger call on failure: logCapture writes
    // its own errors straight to stderr, because logging a failure to persist
    // logs is how that feature turns into an infinite loop.
    // Disable with LOG_CAPTURE=off (which also disables the capture itself).
    if (process.env.LOG_CAPTURE !== 'off') {
      const logCapture = require('./modules/command-center/logCapture');
      // 5s: long enough to batch a burst into one statement, short enough that
      // a crash loses only a few seconds of error lines — and they are still on
      // stdout regardless, which Docker has already collected.
      setInterval(() => { logCapture.flush(); }, 5 * 1000).unref();
      // Retention. Hourly rather than daily so the delete is always small.
      setInterval(() => { logCapture.prune(); }, 60 * 60 * 1000).unref();
      logger.info(
        { flush: '5s', retention_days: Number(process.env.LOG_RETENTION_DAYS) || 30 },
        'Command Center log capture active',
      );
    }

    // Command Center alerting. Without this the Alert Center only notices a
    // problem while somebody has the console open, which is the opposite of
    // what alerting is for — the point is being told when you are NOT looking.
    //
    // Runs in the API process rather than the worker on purpose: the runtime
    // and http collectors measure THIS process (event-loop lag, heap, the
    // request-timing ring), and the worker can see none of it.
    //
    // A plain interval is safe for the same reason it is safe for the
    // announcement dispatcher above: the writes are idempotent. Overlapping
    // ticks cannot double-open an alert, because migration 150 puts a partial
    // unique index on (fingerprint) WHERE status <> 'resolved'.
    // Disable with ALERT_EVALUATION=off.
    if (process.env.ALERT_EVALUATION !== 'off') {
      const alerts = require('./modules/command-center/alerts.service');
      const alertTick = () => alerts.evaluate()
        .then((r) => {
          if (r.opened.length || r.escalated.length || r.resolved.length) {
            logger.info({
              opened: r.opened.map((a) => a.source),
              escalated: r.escalated.map((a) => a.source),
              resolved: r.resolved.map((a) => a.source),
            }, 'Alert evaluation changed state');
          }
        })
        // evaluate() already swallows per-card failures; this is the belt for
        // anything outside them, so a bad tick never becomes an unhandled
        // rejection once a minute for the life of the process.
        .catch((err) => logger.warn({ err: err.message }, 'Alert evaluation failed'));
      // First pass only once boot has settled. Evaluating while the pool is
      // still warming would open a database alert about our own cold start.
      setTimeout(alertTick, 120 * 1000).unref();
      setInterval(alertTick, 60 * 1000).unref();
      logger.info({ interval: '60s' }, 'Command Center alert evaluation scheduled');
    }

    const pool = require('./db/pool');
    function shutdown(sig) {
      return function() {
        logger.info({ signal: sig }, 'Received signal — shutting down');

        // Before server.close(), not inside its callback. `close()` stops
        // accepting new connections and then waits for the open ones to end —
        // and a WebSocket never ends on its own. Left running, every deploy
        // would sit out the full 10s force-exit below for as long as one
        // operator had the console open.
        if (commandCenterStream) commandCenterStream.close(server);

        server.close(async function() {
          try {
            if (workers.length) {
              const { stopWorkers } = require('./workers');
              await stopWorkers();
            }
            const queueLib = require('./jobs/queue');
            await queueLib.closeAll();
            const redisLib = require('./lib/redis');
            await redisLib.close();
          } catch (err) {
            logger.warn({ err: err.message }, 'shutdown cleanup error');
          }
          pool.end(function() { process.exit(0); });
        });
        setTimeout(function() { process.exit(1); }, 10_000).unref();
      };
    }
    process.on('SIGTERM', shutdown('SIGTERM'));
    process.on('SIGINT',  shutdown('SIGINT'));
  })
  .catch(function(err) {
    logger.fatal({ err: err.message }, 'Startup migration failed');
    process.exit(1);
  });

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException — exiting');
  process.exit(1);
});

module.exports = app;
