// src/routes/settings.js — Studio Settings CRUD
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const logger = require('../lib/logger');

// GET /api/settings — List all settings
// ISSUE-028: Non-admin users receive a filtered view that excludes
// internal_, geo_, biometric_, and feature_ prefixed keys.
router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, value, type, description, updated_at FROM system_settings ORDER BY key'
    );

    const isAdminLevel = ['admin', 'super_admin'].includes(req.user.role);
    const RESTRICTED_PREFIXES = ['internal_', 'geo_', 'biometric_', 'feature_'];
    const visibleRows = isAdminLevel
      ? rows
      : rows.filter(r => !RESTRICTED_PREFIXES.some(prefix => r.key.startsWith(prefix)));

    const obj = {};
    for (const r of visibleRows) {
      if (r.type === 'boolean') obj[r.key] = r.value === 'true';
      else if (r.type === 'number') obj[r.key] = parseFloat(r.value);
      else obj[r.key] = r.value;
    }
    res.json({ settings: obj, raw: visibleRows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings — Bulk update settings
router.put('/', auth, adminOnly, async (req, res, next) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object')
      return res.status(400).json({ error: 'Body must be a key-value object' });

    const keys = Object.keys(updates);
    if (!keys.length)
      return res.status(400).json({ error: 'No settings provided' });

    const strVals = keys.map(key => {
      const val = updates[key];
      if (typeof val === 'boolean') return val ? 'true' : 'false';
      if (typeof val === 'number') return String(val);
      return val;
    });

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       SELECT unnest($1::text[]), unnest($2::text[]), NOW()
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [keys, strVals]
    );

    logger.info({ userId: req.user.id, keys }, 'Settings updated');
    res.json({ message: 'Settings updated', count: keys.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/studio — Full studio config for the Studio Settings page
router.get('/studio', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT key, value, type FROM system_settings');
    const settings = {};
    for (const r of rows) {
      if (r.type === 'boolean') settings[r.key] = r.value === 'true';
      else if (r.type === 'number') settings[r.key] = parseFloat(r.value);
      else settings[r.key] = r.value;
    }

    // Get branches
    const { rows: branches } = await pool.query(
      `SELECT s.key AS branch_id, s.value AS name,
              COALESCE((SELECT COUNT(*) FROM clients WHERE branch_id = s.key AND deleted_at IS NULL), 0) AS member_count
       FROM system_settings s
       WHERE s.key LIKE 'branch_%' AND s.type = 'json'
       ORDER BY s.key`
    );

    res.json({ settings, branches });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/branches
router.get('/branches', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT key AS id,
              (value::jsonb)->>'name' AS name,
              (value::jsonb)->>'location' AS location,
              (value::jsonb)->>'status' AS status,
              COALESCE((SELECT COUNT(*) FROM clients WHERE branch_id = s.key AND deleted_at IS NULL), 0)::int AS member_count
       FROM system_settings s
       WHERE s.key LIKE 'branch_%' AND s.type = 'json'
       ORDER BY s.key`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/branches
router.post('/branches', auth, adminOnly, async (req, res, next) => {
  try {
    const { name, location } = req.body;
    if (!name?.trim())
      return res.status(400).json({ error: 'Branch name is required' });

    const id = randomUUID();
    const branchKey = 'branch_' + id;
    const value = JSON.stringify({ name: name.trim(), location: location || '', status: 'active' });

    await pool.query(
      `INSERT INTO system_settings (key, value, type, description, updated_by, updated_at)
       VALUES ($1, $2, 'json', $3, $4, NOW())`,
      [branchKey, value, 'Branch: ' + name.trim(), req.user.id]
    );

    res.status(201).json({ id, name: name.trim(), location: location || '', status: 'active', member_count: 0 });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/branches/:id
router.put('/branches/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const branchKey = 'branch_' + req.params.id;
    const { name, location, status } = req.body;

    const { rows: ex } = await pool.query(
      'SELECT value FROM system_settings WHERE key=$1', [branchKey]
    );
    if (!ex[0]) return res.status(404).json({ error: 'Branch not found' });

    let current;
    try { current = JSON.parse(ex[0].value); } catch { current = {}; }
    const updated = {
      name: name ?? current.name,
      location: location ?? current.location ?? '',
      status: status ?? current.status ?? 'active',
    };

    await pool.query(
      `UPDATE system_settings SET value=$1, updated_by=$2, updated_at=NOW()
       WHERE key=$3`,
      [JSON.stringify(updated), req.user.id, branchKey]
    );

    res.json({ id: req.params.id, ...updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/settings/branches/:id
//
// The client has always had a Delete Branch button; there was no route behind
// it, so it 404'd and the row stayed on screen.
//
// Refuses rather than orphans. `clients.branch_id` holds the full
// system_settings key (see the member_count subquery on GET /branches), and
// there is no FK to cascade or null it out — deleting a branch with members
// would leave those rows pointing at a key that no longer resolves, and they
// would silently vanish from every per-branch view. A studio that wants the
// branch out of the way without moving its members can PUT status:'inactive'.
router.delete('/branches/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const branchKey = 'branch_' + req.params.id;

    const { rows: ex } = await pool.query(
      'SELECT key FROM system_settings WHERE key=$1', [branchKey]
    );
    if (!ex[0]) return res.status(404).json({ error: 'Branch not found' });

    const { rows: [{ member_count }] } = await pool.query(
      `SELECT COUNT(*)::int AS member_count
         FROM clients WHERE branch_id=$1 AND deleted_at IS NULL`,
      [branchKey]
    );
    if (member_count > 0) {
      return res.status(409).json({
        error: `Cannot delete a branch with ${member_count} member${member_count === 1 ? '' : 's'}. `
             + 'Move them to another branch first, or set this one to inactive.',
      });
    }

    await pool.query('DELETE FROM system_settings WHERE key=$1', [branchKey]);
    res.json({ message: 'Branch deleted' });
  } catch (err) {
    next(err);
  }
});

// ── GYM / BIOMETRIC SETTINGS ─────────────────────────────────────────────────
const GYM_KEYS = [
  'geofence_lat', 'geofence_lng', 'geofence_radius',
  'enable_face_id', 'enable_touch_id', 'enable_gps',
  'duplicate_window_minutes', 'auto_checkout', 'auto_checkout_minutes',
];

const GYM_DEFAULTS = {
  geofence_lat: 19.076,
  geofence_lng: 72.8777,
  geofence_radius: 100,
  enable_face_id: true,
  enable_touch_id: true,
  enable_gps: true,
  duplicate_window_minutes: 60,
  auto_checkout: false,
  auto_checkout_minutes: 120,
};

// GET /api/settings/gym
router.get('/gym', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value, type FROM system_settings WHERE key = ANY($1::text[])`,
      [GYM_KEYS]
    );
    const result = { ...GYM_DEFAULTS };
    for (const r of rows) {
      if (r.type === 'boolean') result[r.key] = r.value === 'true';
      else if (r.type === 'number') result[r.key] = parseFloat(r.value);
      else result[r.key] = r.value;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/gym
router.put('/gym', auth, adminOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    const allowedKeys = GYM_KEYS.filter(k => body[k] !== undefined);
    if (!allowedKeys.length) return res.status(400).json({ error: 'No valid gym settings provided' });

    const strVals = allowedKeys.map(key => {
      const raw = body[key];
      if (typeof raw === 'boolean') return raw ? 'true' : 'false';
      if (typeof raw === 'number') return String(raw);
      return String(raw);
    });

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       SELECT unnest($1::text[]), unnest($2::text[]), NOW()
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [allowedKeys, strVals]
    );

    logger.info({ userId: req.user.id, keys: allowedKeys }, 'Gym settings updated');
    res.json({ success: true, message: 'Gym settings saved', count: allowedKeys.length });
  } catch (err) {
    next(err);
  }
});

// ── ROLE PERMISSIONS ─────────────────────────────────────────────────────────

const PERM_KEYS = [
  'perm_trainer_pt_module', 'perm_trainer_finance', 'perm_trainer_reports',
  'perm_trainer_insights', 'perm_trainer_staff_view', 'perm_trainer_settings',
  'perm_trainer_all_pt_clients', 'perm_trainer_commissions', 'perm_trainer_record_payment',
  'perm_reception_pt_module', 'perm_reception_finance', 'perm_reception_reports',
  'perm_reception_insights', 'perm_reception_settings', 'perm_reception_staff_view',
  'perm_reception_record_payment',
];

const PERM_DEFAULTS = {
  perm_trainer_pt_module: true,
  perm_trainer_finance: false,
  perm_trainer_reports: false,
  perm_trainer_insights: false,
  perm_trainer_staff_view: true,
  perm_trainer_settings: false,
  perm_trainer_all_pt_clients: false,
  perm_trainer_commissions: true,
  perm_trainer_record_payment: false,
  perm_reception_pt_module: false,
  perm_reception_finance: false,
  perm_reception_reports: false,
  perm_reception_insights: false,
  perm_reception_settings: false,
  perm_reception_staff_view: true,
  perm_reception_record_payment: true,
};

// GET /api/settings/permissions
router.get('/permissions', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM system_settings WHERE key = ANY($1::text[])`,
      [PERM_KEYS]
    );
    const perms = { ...PERM_DEFAULTS };
    for (const r of rows) {
      perms[r.key] = r.value === 'true';
    }
    res.json({ permissions: perms, role: req.user.role });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/permissions
router.put('/permissions', auth, adminOnly, async (req, res, next) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object')
      return res.status(400).json({ error: 'Body must be a key-value object' });

    const keys = PERM_KEYS.filter(k => updates[k] !== undefined);
    if (keys.length) {
      const strVals = keys.map(k => updates[k] ? 'true' : 'false');
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_at)
         SELECT unnest($1::text[]), unnest($2::text[]), NOW()
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [keys, strVals]
      );
    }
    res.json({ message: 'Permissions updated' });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/feature-flags
router.get('/feature-flags', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT key, value, description FROM feature_flags ORDER BY key');
    const flags = {};
    for (const r of rows) flags[r.key] = r.value;
    res.json({ flags, raw: rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/feature-flags
router.put('/feature-flags', auth, adminOnly, async (req, res, next) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object')
      return res.status(400).json({ error: 'Body must be a key-value object' });

    const keys = Object.keys(updates);
    if (!keys.length) return res.json({ message: 'Feature flags updated', updated: 0, requested: 0 });

    // One statement, atomic by construction — the same shape PUT /permissions
    // above uses for the same class of bulk key/value write.
    //
    // This was a `for` loop issuing one UPDATE per key with no transaction
    // around it. A failure partway through (dropped connection, constraint
    // error on flag 3 of 5) left flags 1-2 committed, 4-5 never attempted, and
    // returned a single 500 that read as "nothing happened" — so the operator's
    // next move was to retry a write that had already half-applied. Feature
    // flags gate real functionality, so a half-applied set is a half-configured
    // product, not a cosmetic problem.
    const vals = keys.map((k) => Boolean(updates[k]));
    const { rowCount } = await pool.query(
      `UPDATE feature_flags AS f
          SET value = v.value, updated_at = NOW()
         FROM unnest($1::text[], $2::boolean[]) AS v(key, value)
        WHERE f.key = v.key`,
      [keys, vals]
    );

    // Report what actually changed. Unknown keys match no row and are skipped
    // silently — true of the loop too — so returning the count lets a caller
    // notice a typo instead of reading "updated" and believing it.
    res.json({ message: 'Feature flags updated', updated: rowCount, requested: keys.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
