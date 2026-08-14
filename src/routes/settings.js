// src/routes/settings.js — Studio Settings, per studio.
//
// ── What changed here, and why it was the biggest defect in the audit ───────
//
// Every handler in this file used to read and write `system_settings`, which is
// ONE global key/value table with no organization_id. So all six live studios
// shared one studio name, one address, one currency, one timezone, one set of
// check-in and geofence settings, one set of role permissions, and one list of
// branches. `GET /api/settings` returned the platform's entire configuration to
// any authenticated user, and every write applied to everybody: renaming your
// studio renamed all of them, and `DELETE /branches/:id` deleted another
// studio's branch.
//
// That is V-06 in TENANT_SECURITY_AUDIT.md, recorded there as "the single
// largest architectural defect in the audit: there is no per-studio
// configuration store at all."
//
// Migration 167 creates one — `organization_settings`, keyed
// (organization_id, key) — and turns branches into rows in the real `branches`
// table with an organization_id. This file now reads and writes those.
//
// ── Why the migration could fan the old values out without guessing ─────────
//
// Configuration keys were shared BY DESIGN: every studio was already reading
// the same `currency` row, so giving each studio a copy of that value changes
// nothing for anyone. That is what separates this from the sixteen tables
// TENANT_SECURITY_AUDIT.md §5 gates on a production count — there a row belongs
// to one studio and nothing records which; here it belonged to all of them.
//
// Branches were the opposite and needed real attribution, which they had:
// POST /branches has always stamped updated_by, so the creating admin's
// organization owns the branch. See migration 167 §4.
//
// ── system_settings is not dropped ─────────────────────────────────────────
//
// The rows are left exactly as they were and this file simply stops reading
// them, which keeps the change reversible by reverting code rather than by
// restoring data. `internal_*` keys stay there and stay operator-only.

const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { orgIdOf } = require('../lib/tenant-db');
const logger = require('../lib/logger');

/**
 * The caller's organization, or null for a platform super admin operating
 * platform-wide.
 *
 * Settings are per studio, so a request with no organization has no settings to
 * read or write. Every handler below refuses rather than falling back to a
 * global view — falling back is what this file used to do, and it is the bug.
 */
function orgOf(req) {
  return orgIdOf(req);
}

const NO_ORG = {
  error: {
    code: 'ORG_REQUIRED',
    message: 'Settings belong to a studio. Select one to continue.',
  },
};

/** Coerce a JS value to the TEXT column, preserving the old encoding. */
function toText(val) {
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  return val === null || val === undefined ? null : String(val);
}

/** Decode a stored row back to its declared type. */
function fromRow(r) {
  if (r.type === 'boolean') return r.value === 'true';
  if (r.type === 'number') return parseFloat(r.value);
  return r.value;
}

/** Read some or all of one studio's settings. */
async function readSettings(orgId, keys) {
  const sql = keys
    ? `SELECT key, value, type, description, updated_at FROM organization_settings
        WHERE organization_id = $1 AND key = ANY($2::text[]) ORDER BY key`
    : `SELECT key, value, type, description, updated_at FROM organization_settings
        WHERE organization_id = $1 ORDER BY key`;
  const { rows } = await pool.query(sql, keys ? [orgId, keys] : [orgId]);
  return rows;
}

/**
 * Upsert keys for one studio, in a single statement.
 *
 * One statement rather than a loop, for the reason the feature-flags handler
 * below already sets out: a loop that fails partway leaves some keys written
 * and some not, and returns an error that reads as "nothing happened".
 */
async function writeSettings(orgId, keys, values, userId) {
  await pool.query(
    `INSERT INTO organization_settings (organization_id, key, value, updated_by, updated_at)
     SELECT $1, k, v, $4, NOW() FROM unnest($2::text[], $3::text[]) AS t(k, v)
     ON CONFLICT (organization_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [orgId, keys, values, userId]
  );
}

// ── GET /api/settings ───────────────────────────────────────────────────────
//
// ISSUE-028: non-admin users get a filtered view that excludes internal_, geo_,
// biometric_ and feature_ prefixed keys. Kept as it was — but note it is now a
// second filter applied on top of the tenant boundary, not the only one
// standing between a receptionist and the platform's configuration.
router.get('/', auth, async (req, res, next) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json(NO_ORG);

    const rows = await readSettings(orgId);

    const isAdminLevel = ['admin', 'super_admin'].includes(req.user.role);
    const RESTRICTED_PREFIXES = ['internal_', 'geo_', 'biometric_', 'feature_'];
    const visibleRows = isAdminLevel
      ? rows
      : rows.filter((r) => !RESTRICTED_PREFIXES.some((p) => r.key.startsWith(p)));

    const obj = {};
    for (const r of visibleRows) obj[r.key] = fromRow(r);
    res.json({ settings: obj, raw: visibleRows });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/settings — bulk update ─────────────────────────────────────────
router.put('/', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json(NO_ORG);

    const updates = req.body;
    if (!updates || typeof updates !== 'object')
      return res.status(400).json({ error: 'Body must be a key-value object' });

    const keys = Object.keys(updates);
    if (!keys.length) return res.status(400).json({ error: 'No settings provided' });

    await writeSettings(orgId, keys, keys.map((k) => toText(updates[k])), req.user.id);

    logger.info({ userId: req.user.id, orgId, keys }, 'Settings updated');
    res.json({ message: 'Settings updated', count: keys.length });
  } catch (err) {
    next(err);
  }
});

// ── Branches ────────────────────────────────────────────────────────────────
//
// Real rows in `branches` now, not `branch_*` keys in a global key/value table.
//
// `member_count` is reported as 0 and no longer computed. It used to be
// `SELECT COUNT(*) FROM clients WHERE branch_id = <the settings key>` — against
// the legacy `clients` table, which has held 0 rows since PT-OS enrolment
// shipped and which clients.legacy-table.test.js now fails the build over. So
// the number on screen was always zero and always would be. Reporting a real
// count needs a branch_id on the member, which arrives with the member domain's
// own branch support; inventing one from a table nothing writes would be worse
// than a zero, because a zero is at least visibly a placeholder.
const BRANCH_COLUMNS = `id,
  name,
  COALESCE(address, '') AS location,
  CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS status`;

router.get('/branches', auth, async (req, res, next) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json(NO_ORG);

    const { rows } = await pool.query(
      `SELECT ${BRANCH_COLUMNS}
         FROM branches
        WHERE organization_id = $1 AND deleted_at IS NULL
        ORDER BY name`,
      [orgId]
    );
    res.json(rows.map((r) => ({ ...r, member_count: 0 })));
  } catch (err) {
    next(err);
  }
});

router.post('/branches', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json(NO_ORG);

    const { name, location } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Branch name is required' });

    const { rows } = await pool.query(
      `INSERT INTO branches (id, organization_id, name, address, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING ${BRANCH_COLUMNS}`,
      [randomUUID(), orgId, name.trim(), location || null]
    );
    res.status(201).json({ ...rows[0], member_count: 0 });
  } catch (err) {
    // uq_branches_org_name is scoped per studio, so this only fires on a
    // genuine duplicate within the caller's own studio.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A branch with this name already exists.' });
    }
    next(err);
  }
});

router.put('/branches/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json(NO_ORG);

    const { name, location, status } = req.body;
    const sets = [];
    const params = [req.params.id, orgId];
    if (name !== undefined)     { params.push(name);     sets.push(`name = $${params.length}`); }
    if (location !== undefined) { params.push(location); sets.push(`address = $${params.length}`); }
    if (status !== undefined)   { params.push(status === 'active'); sets.push(`is_active = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at = NOW()');

    // The organization predicate is in the UPDATE's own WHERE. A guard that
    // lives only in a preceding lookup stops holding the first time somebody
    // reorders the handler.
    const { rows } = await pool.query(
      `UPDATE branches SET ${sets.join(', ')}
        WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
        RETURNING ${BRANCH_COLUMNS}`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Branch not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A branch with this name already exists.' });
    }
    next(err);
  }
});

// DELETE /api/settings/branches/:id — soft delete.
//
// The old handler refused to delete a branch with members attached, counting
// them from the legacy `clients` table. That count was structurally always
// zero, so the guard never fired and was not really a guard. It is dropped
// rather than reimplemented against a table that does not yet record a member's
// branch; when the member domain gains branch assignment, the check comes back
// against `members`.
//
// Soft delete rather than hard: uq_branches_org_name is partial on deleted_at,
// so the name is freed for reuse, and the row survives for anything historical
// that referenced it.
router.delete('/branches/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json(NO_ORG);

    const { rows } = await pool.query(
      `UPDATE branches SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
        RETURNING id`,
      [req.params.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Branch not found' });
    res.json({ message: 'Branch deleted' });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/settings/studio — settings + branches for the Studio page ──────
router.get('/studio', auth, async (req, res, next) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json(NO_ORG);

    const [settingsRows, branchRows] = await Promise.all([
      readSettings(orgId),
      pool.query(
        `SELECT ${BRANCH_COLUMNS} FROM branches
          WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY name`,
        [orgId]
      ),
    ]);

    const settings = {};
    for (const r of settingsRows) settings[r.key] = fromRow(r);

    res.json({
      settings,
      branches: branchRows.rows.map((b) => ({ branch_id: b.id, name: b.name, member_count: 0 })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GYM / BIOMETRIC SETTINGS ────────────────────────────────────────────────

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

router.get('/gym', auth, async (req, res, next) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json(NO_ORG);

    const rows = await readSettings(orgId, GYM_KEYS);
    const result = { ...GYM_DEFAULTS };
    for (const r of rows) result[r.key] = fromRow(r);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.put('/gym', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json(NO_ORG);

    const body = req.body || {};
    const keys = GYM_KEYS.filter((k) => body[k] !== undefined);
    if (!keys.length) return res.status(400).json({ error: 'No valid gym settings provided' });

    await writeSettings(orgId, keys, keys.map((k) => toText(body[k])), req.user.id);

    logger.info({ userId: req.user.id, orgId, keys }, 'Gym settings updated');
    res.json({ success: true, message: 'Gym settings saved', count: keys.length });
  } catch (err) {
    next(err);
  }
});

// ── ROLE PERMISSIONS ────────────────────────────────────────────────────────
//
// Per studio now. These decide what a studio's own trainers and receptionists
// can reach, and one studio's answer has no business applying to another's —
// which is exactly what a single global row meant.

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

router.get('/permissions', auth, async (req, res, next) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json(NO_ORG);

    const rows = await readSettings(orgId, PERM_KEYS);
    const perms = { ...PERM_DEFAULTS };
    for (const r of rows) perms[r.key] = r.value === 'true';
    res.json({ permissions: perms, role: req.user.role });
  } catch (err) {
    next(err);
  }
});

router.put('/permissions', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json(NO_ORG);

    const updates = req.body;
    if (!updates || typeof updates !== 'object')
      return res.status(400).json({ error: 'Body must be a key-value object' });

    const keys = PERM_KEYS.filter((k) => updates[k] !== undefined);
    if (keys.length) {
      await writeSettings(orgId, keys, keys.map((k) => (updates[k] ? 'true' : 'false')), req.user.id);
    }

    logger.info({ userId: req.user.id, orgId, keys }, 'Permissions updated');
    res.json({ message: 'Permissions updated', count: keys.length });
  } catch (err) {
    next(err);
  }
});

// ── FEATURE FLAGS (legacy) ──────────────────────────────────────────────────
//
// DELIBERATELY NOT tenant-scoped here, and recorded as V-17 in
// TENANT_SECURITY_AUDIT.md rather than quietly fixed.
//
// `feature_flags` is the pre-multi-tenant flag table. It was superseded by the
// feature manager in migration 123 — platform_features + organization_features
// + plan_features, resolved per studio by lib/features.js — which is what
// `gate()` in server.js and the whole Control Centre actually use.
//
// These two endpoints have no caller. `settings.getFeatureFlags` and
// `settings.updateFeatureFlags` are defined in the frontend's api barrel and
// invoked from nowhere, the same shape as the dead `member.get` /
// `member.metrics` that MEMBERS-TENANT-GAP.md found before deleting
// /api/v1/members.
//
// So the honest options are removal or migration onto the feature manager, and
// both are legacy-cleanup decisions with their own evidence to gather — not
// something to settle inside the settings tenanting change. Adding an
// organization_id to a table that has already been replaced would be building
// on the thing being retired. See docs/LEGACY_SYSTEM_INVENTORY.md.
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

router.put('/feature-flags', auth, adminOnly, async (req, res, next) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object')
      return res.status(400).json({ error: 'Body must be a key-value object' });

    const keys = Object.keys(updates);
    if (!keys.length) return res.json({ message: 'Feature flags updated', updated: 0, requested: 0 });

    // One statement, atomic by construction — the same shape the settings
    // writes above use for the same class of bulk key/value write.
    //
    // This was a `for` loop issuing one UPDATE per key with no transaction
    // around it. A failure partway through (dropped connection, constraint
    // error on flag 3 of 5) left flags 1-2 committed, 4-5 never attempted, and
    // returned a single 500 that read as "nothing happened" — so the operator's
    // next move was to retry a write that had already half-applied.
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
