// src/routes/features.js
//
// The tenant's read-only view of its own feature flags.
//
// New surface, additive: nothing that existed before consults it, and adding
// it changes no existing behaviour. It exists so a studio's UI can hide what
// the studio does not have, instead of showing a panel that 403s when tapped.
//
// Strictly scoped to the caller's own organization. There is no parameter for
// which studio to ask about — the organization comes off the authenticated
// session and nowhere else, so no amount of request tampering reaches another
// tenant's configuration.
'use strict';

const router = require('express').Router();
const pool = require('../db/pool');
const featuresLib = require('../lib/features');
const { auth } = require('../middleware/auth');

// Same shape as routes/profile.js: the guard is declared by the router itself,
// so mounting it can never accidentally leave it unauthenticated.
router.use(auth);

// GET /api/features — { data: { key: boolean, ... } }
router.get('/', async (req, res, next) => {
  try {
    const orgId = req.user?.organization_id;
    // A platform operator is not inside a tenant, so there is no per-studio
    // answer to give. Returning an empty map rather than 403 keeps a shared
    // client component from having to special-case the operator.
    if (!orgId || req.user.role === 'super_admin') return res.json({ data: {} });

    const { rows } = await pool.query('SELECT plan_code FROM organizations WHERE id = $1', [orgId]);
    const map = await featuresLib.mapForOrg(orgId, rows[0]?.plan_code || null);
    // Short cache: flags change rarely, and a stale value for a minute is far
    // cheaper than this query on every navigation. Private — the answer is
    // specific to one tenant and must never land in a shared cache.
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ data: map });
  } catch (err) { next(err); }
});

module.exports = router;
