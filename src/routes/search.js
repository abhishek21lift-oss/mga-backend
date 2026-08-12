'use strict';
/**
 * GET /api/search — the global search box in the top navigation.
 *
 * Deliberately thin: parsing, authorisation and rate limiting live here, the
 * actual searching lives in modules/search/search.service.js behind a provider
 * registry. New searchable entity types are added there and appear in this
 * response automatically — this file does not change.
 *
 * Response envelope (stable across future entity types):
 *   { data: { query, groups: [{ type, label, total, items: [...] }], took_ms } }
 *
 * Note there is no "recently viewed" group. Recency is per-person, per-device
 * and worthless to anyone else; keeping it in the browser means it is instant,
 * survives a cold backend, and never becomes another cross-tenant surface to
 * defend. The frontend renders it from local storage when the box is empty.
 */

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { makeStore } = require('../lib/rateLimitStore');
const { auth } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');
const searchService = require('../modules/search/search.service');

// Search is called far more often than a normal endpoint — a 300ms debounce
// still produces several requests per typed word — so it gets its own budget
// rather than eating the shared per-user allowance. 4/s sustained is well above
// what debounced typing generates and low enough that the box cannot be used to
// enumerate a database.
const searchLimiter = rateLimit({
  store: makeStore('search'),
  passOnStoreError: true,
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip,
  message: { error: 'Too many searches. Please slow down.' },
});

router.get('/', auth, searchLimiter, async (req, res, next) => {
  try {
    // Tenant isolation. Resolved here and handed to the service, which requires
    // it — a provider cannot accidentally run unscoped because the scope is the
    // only way it gets a WHERE clause.
    const scope = tenantScope(req);

    // A trainer sees only their own roster. This is narrower than the org
    // filter and is applied in addition to it, never instead of it. Admins and
    // managers get the whole studio, which is the existing rule everywhere else
    // (see routes/clients.js).
    const trainerId = req.user.role === 'trainer' ? (req.user.trainer_id || null) : null;
    // A trainer whose account has no trainer record must not fall through to
    // the whole studio. Fail closed.
    if (req.user.role === 'trainer' && !trainerId) {
      return res.json({ data: { query: String(req.query.q || ''), groups: [], took_ms: 0 } });
    }

    // Optional filter, for callers that want one entity type (e.g. a picker
    // reusing this endpoint). Unknown names are simply ignored by the service.
    const types = typeof req.query.types === 'string'
      ? req.query.types.split(',').map((t) => t.trim()).filter(Boolean)
      : null;

    const data = await searchService.search({
      query: req.query.q,
      scope,
      trainerId,
      // AI conversations are personal, not organizational, so that provider
      // scopes on the user rather than the org. Role gates the groups a
      // trainer is not offered at all (see PROVIDERS).
      userId: req.user.id,
      role: req.user.role,
      limit: req.query.limit,
      types,
    });

    // Personal, tenant-scoped and cheap to recompute — never let a shared cache
    // hold one studio's results where another can be served them.
    res.set('Cache-Control', 'private, no-store');
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
