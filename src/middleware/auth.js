// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { computeAccess } = require('../lib/subscription');
const { resolveOrgId } = require('./tenant');
const { runWithTenantContext } = require('../lib/tenant-context');

// Off by default — see TENANT-RLS-PLAN.md. Enabling this makes pool.js wrap
// queries in a transaction that sets app.org_id for Postgres RLS to read; it
// does nothing to what the app can reach until DATABASE_URL also points at
// the app_tenant role (157_app_tenant_role_and_rls.sql), which is its own,
// separately-tested deployment step.
const TENANT_RLS_ENFORCE = process.env.TENANT_RLS_ENFORCE === 'on';

// Path prefixes that stay reachable even when a studio's subscription has lapsed,
// so the studio can still authenticate, view its billing/frozen screen, manage
// its own profile, and the platform operator can always get in.
const SUBSCRIPTION_ALLOWLIST = [
  '/api/auth', '/api/v1/auth', '/api/profile',
  '/api/subscription', '/api/super-admin', '/api/health',
];

// Returns the blocking access decision when a tenant user's studio may not use
// protected features, else null. Super admins and org-less users bypass.
function subscriptionBlocked(req) {
  const u = req.user;
  if (!u || !u.organization_id || u.role === 'super_admin') return null;
  // subscription columns are absent on the legacy fallback query — fail open.
  if (u.subscription_status === undefined && u.organization_status === undefined) return null;
  const access = computeAccess({
    status: u.organization_status,
    subscription_status: u.subscription_status,
    trial_ends_at: u.trial_ends_at,
    current_period_end: u.current_period_end,
  });
  req.subscriptionAccess = access;
  return access.allowed ? null : access;
}

// In-memory user cache. The token only carries `id`; we re-load the row
// on every request so role / trainer_id / is_active changes propagate
// instantly. To avoid hitting Postgres on every API call, cache the
// resolved user for a short TTL.
const USER_CACHE_TTL_MS = 30000;
const USER_CACHE_MAX    = 500;
const userCache = new Map(); // id -> { user, expiresAt }
function _cacheGet(id) {
  const hit = userCache.get(id);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { userCache.delete(id); return null; }
  return hit.user;
}
function _cacheSet(id, user) {
  // M-03: proper LRU — delete+re-insert moves the key to the end of insertion order.
  // Then evict oldest entries until within the cap.
  userCache.delete(id);
  userCache.set(id, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  while (userCache.size > USER_CACHE_MAX) {
    userCache.delete(userCache.keys().next().value);
  }
}
function invalidateUserCache(userId) {
  if (userId == null) userCache.clear();
  else userCache.delete(userId);
}

// Periodic cleanup of expired entries (runs every 60s, never prevents exit)
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of userCache) {
    if (entry.expiresAt < now) userCache.delete(id);
  }
}, 60_000).unref();

async function auth(req, res, next) {
  let token = null;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7);
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    let user = _cacheGet(decoded.id);
    if (!user) {
      let rows;
      try {
        const result = await pool.query(
          // FIX: token_version is now selected so revocation check below works.
          // member_id is needed by requireSelfOrRole (v3 RBAC).
          // organization_id carries the tenant boundary onto req.user for the
          // multi-tenant isolation layer (migration 078).
          // SECURITY: filter out soft-deleted users (deleted_at IS NOT NULL).
          // pt_client_id is the client-account link, and it is a DIFFERENT
          // column from member_id — member_id carries a foreign key to the
          // legacy, empty `clients` table (migration 154 explains why).
          // requireClient and every /api/me query read it off req.user, so it
          // has to load here with role and organization_id: taking a client id
          // from the request instead is the exact mistake the isolation layer
          // exists to prevent.
          // Via auth_user_by_id, not a direct SELECT: this read happens on
          // every request and is what resolveOrgId derives the organization
          // from, so it necessarily runs before tenant context exists. Under
          // RLS a direct read finds nothing and every authenticated request
          // answers "Account not found or disabled". See migration 160.
          `SELECT id, name, email, role, trainer_id, member_id, pt_client_id, branch_id,
                  organization_id, organization_name, organization_logo_url,
                  is_founder, founder_number,
                  organization_status, subscription_status,
                  trial_ends_at, current_period_end,
                  is_active, token_version
             FROM auth_user_by_id($1)`,
          [decoded.id]
        );
        rows = result.rows;
      } catch {
        // Fallback if deleted_at column doesn't exist (pre-migration).
        // pt_client_id is selected here too: this branch runs on a database
        // behind on migrations, and a client whose account silently loads
        // without its link would be refused by requireClient with no clue why.
        // If 154 has not run either, this query fails and the caller gets a
        // clean 401 rather than a session missing its tenant identity.
        const result = await pool.query(
          `SELECT u.id, u.name, u.email, u.role, u.trainer_id, u.member_id, u.pt_client_id, u.branch_id,
                  u.organization_id, o.name AS organization_name, o.logo_url AS organization_logo_url,
                  o.is_founder, o.founder_number,
                  u.is_active, u.token_version
             FROM users u
             LEFT JOIN organizations o ON o.id = u.organization_id
            WHERE u.id = $1`,
          [decoded.id]
        );
        rows = result.rows;
      }
      user = rows[0];
      if (!user || !user.is_active) {
        return res.status(401).json({ error: 'Account not found or disabled' });
      }
      // Token revocation: if the JWT's token_version doesn't match the DB,
      // the user's token has been invalidated (e.g. password changed, deactivated).
      if (decoded.token_version !== undefined && user.token_version !== undefined &&
          user.token_version !== decoded.token_version) {
        return res.status(401).json({ error: 'Session expired, please log in again' });
      }
      _cacheSet(user.id, user);
    }

    req.user = user;

    // Super-admin impersonation: the token carries an `imp` claim minted by the
    // platform portal. req.user is already the impersonated admin (loaded above),
    // so the whole app renders as them. While read-only (`ro`), reject every
    // mutating request — the operator must exit impersonation to make changes.
    if (decoded.imp) {
      req.impersonation = decoded.imp;
      const method = (req.method || 'GET').toUpperCase();
      if (decoded.imp.ro && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        return res.status(403).json({
          error: {
            code: 'IMPERSONATION_READONLY',
            message: 'Read-only impersonation: changes are disabled. Exit impersonation to act as admin.',
          },
        });
      }
    }

    // Subscription enforcement (SaaS billing). Compute the studio's access state
    // from its cached subscription snapshot and block protected routes when the
    // trial/subscription has lapsed or the studio is suspended. Super admins,
    // legacy org-less users, and impersonation sessions bypass. Timestamps drive
    // expiry, so this is correct even off a cached user row.
    if (!req.impersonation) {
      const blocked = subscriptionBlocked(req);
      if (blocked) {
        const path = (req.originalUrl || req.url || '').split('?')[0];
        const allowed = SUBSCRIPTION_ALLOWLIST.some((p) => path.startsWith(p));
        if (!allowed) {
          return res.status(402).json({
            error: { code: 'SUBSCRIPTION_INACTIVE', state: blocked.state, message: blocked.reason },
          });
        }
      }
    }

    // Tenant context for db/pool.js's RLS query wrapper. Resolution failure
    // must never block the request — this flag is for testing whether the
    // wrapper works, not a new authorization gate, and NO_TENANT is already
    // handled properly by requireRole/requireClient/etc. further down the
    // chain for routes that actually need it.
    if (TENANT_RLS_ENFORCE) {
      let orgId = null;
      try { orgId = resolveOrgId(req); } catch { /* see comment above */ }
      return runWithTenantContext(orgId, next);
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Allows admin OR manager roles.
 * Use for operations that managers should be able to perform
 * (e.g. delete trainer, edit plans) but regular staff cannot.
 */
function adminOrManager(req, res, next) {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'manager') {
    return res.status(403).json({ error: 'Admin or manager access required' });
  }
  next();
}

/**
 * Allows admin, manager OR trainer.
 *
 * Programme authoring is a trainer's job. Until now the workout-plan writes
 * sat behind adminOrManager, so the people the module exists for got a 403 on
 * every save and a studio owner had to build every programme themselves.
 *
 * This is only the ROLE gate. It deliberately does not decide WHICH plan a
 * trainer may touch — that needs the plan row, so it lives next to the query
 * that loads it (see loadEditablePlan in routes/workouts.js, which restricts a
 * trainer to plans they created or that are assigned to a client they train).
 * Splitting it this way keeps the middleware synchronous and keeps the
 * ownership rule in one place rather than duplicated across five handlers.
 */
function adminManagerOrTrainer(req, res, next) {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'manager' && role !== 'trainer') {
    return res.status(403).json({ error: 'Admin, manager or trainer access required' });
  }
  next();
}

// FIX (Route Integrity R-09):
// requireRole and requireSelfOrRole were previously duplicated between
// auth.js and rbac.js with different signatures and error response shapes:
//   auth.js   — requireRole(roles: string[])  → { error: 'string' }
//   rbac.js   — requireRole(...roles)          → { error: { code, message } }
//
// The canonical implementations now live in rbac.js. We re-export them
// from auth.js for backward compatibility so existing route files that
// import from './middleware/auth' continue to work without changes.
// Do not re-implement these functions here — import from rbac.js.
const { requireRole, requireSelfOrRole } = require('./rbac');

module.exports = {
  auth,
  adminOnly,
  adminOrManager,
  adminManagerOrTrainer,
  requireRole,
  requireSelfOrRole,
  invalidateUserCache,
};
