// src/middleware/rbac.js
// Role-Based Access Control. Use after auth() middleware.
//
// Usage:
//   router.get('/admin-only', auth, requireRole('admin'), handler);
//   router.get('/staff',      auth, requireRole('admin','trainer'), handler);
//   router.get('/own-or-admin/:id', auth, requireSelfOrRole('admin'), handler);

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: `Requires one of: ${roles.join(', ')}` },
      });
    }
    next();
  };
}

// Allow a member to access only their own resource (matched by :id in URL)
// or any user with one of the elevated roles.
function requireSelfOrRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
    if (roles.includes(req.user.role)) return next();

    // For members: id in URL must match their member_id
    if (req.user.role === 'member' && req.params.id && req.params.id === req.user.member_id) {
      return next();
    }
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot access this resource' } });
  };
}

// For trainers: only allow access to assigned members.
//
// IMPORTANT: this is a middleware FACTORY, so it must be a synchronous
// function that returns the middleware. The previous version was declared
// `async function`, which made `requireTrainerOwnership(pool)` resolve to
// a Promise — Express then tried to use the Promise as middleware and
// every request hung. Using a plain function fixes that.
function requireTrainerOwnership(pool, paramName = 'id') {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTH' } });
    if (req.user.role === 'admin') return next();
    if (req.user.role !== 'trainer') return res.status(403).json({ error: { code: 'FORBIDDEN' } });

    const memberId = req.params[paramName];
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM clients WHERE id = $1 AND trainer_id = $2
         UNION
         SELECT 1 FROM pt_clients WHERE id = $1 AND trainer_id = $2
         LIMIT 1`,
        [memberId, req.user.trainer_id]
      );
      if (rows.length === 0) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Member not assigned to you' } });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * The roles that run a studio, as opposed to the people it trains.
 *
 * `member` is deliberately absent, and that absence is the point — see
 * requireStaff.
 */
const STAFF_ROLES = ['super_admin', 'admin', 'manager', 'staff', 'trainer', 'reception', 'receptionist'];

/**
 * Everything behind a studio's back office.
 *
 * Written as an allow-list of staff rather than a deny-list of `member`
 * because the failure modes are not symmetric. A role added later and
 * forgotten here gets a 403 — visible, annoying, fixed in a minute. A role
 * added to a deny-list-shaped check and forgotten gets the whole studio, and
 * nobody finds out.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Read routes across the staff modules were gated on `auth` alone. That was
 * survivable only because no account had ever held the `member` role: there
 * was nobody to abuse it. Client logins create those accounts by the hundred,
 * and on the day the first one is activated `GET /api/pt-os/clients` would
 * hand that client the studio's entire client list — names, phone numbers,
 * balances — with a valid token and no exploit required. Same for
 * /dashboard's revenue, and /clients/:id for anybody's record.
 *
 * So this ships WITH the activation feature, not after it. A client's own
 * data is served by /api/me, which scopes to the caller.
 */
function requireStaff(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
  }
  if (!STAFF_ROLES.includes(req.user.role)) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'This area is for studio staff.' },
    });
  }
  next();
}

/**
 * The mirror of requireStaff: a client, acting on their own behalf.
 *
 * Requires the account to actually be linked to a client record. A `member`
 * row with no pt_client_id is a half-built account, and serving it an empty
 * profile is worse than refusing it — it looks like their data was lost.
 */
function requireClient(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: { code: 'UNAUTH', message: 'Not authenticated' } });
  }
  if (req.user.role !== 'member' || !req.user.pt_client_id) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'This area is for client accounts.' },
    });
  }
  next();
}

module.exports = {
  requireRole, requireSelfOrRole, requireTrainerOwnership,
  requireStaff, requireClient, STAFF_ROLES,
};
