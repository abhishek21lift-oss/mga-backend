// src/routes/members.js — the gym member.
//
// Phase 2 of the GMS transformation. A member is a person who belongs to the
// gym; a PT client is a member who has ALSO bought personal training. Until
// now those were the same row, so there was no way to represent someone who
// pays for gym access and never meets a trainer — most of a real gym's roster.
// See docs/GMS_TARGET_ARCHITECTURE.md §1 and migration 166.
//
// ── This is not /api/v1/members coming back ─────────────────────────────────
//
// That endpoint was deleted and src/__tests__/membersEndpointRemoved.test.js
// fails the build if it returns. It served nine routes off a table with no
// organization_id, and its list() had no org predicate for admin or manager at
// all — so it had neither an application-layer nor a database-layer tenant
// boundary. MEMBERS-TENANT-GAP.md is the record.
//
// The guard stays exactly as it is. This is a different path (/api/members),
// on a different table (migration 166's, which is org-scoped from birth and
// NOT NULL), and every query below carries the predicate the old one lacked.
// The removal note asked that if it ever came back it must come back with a
// tenant boundary. This is that.
//
// ── Member codes, and the three defects not to repeat ───────────────────────
//
// MEMBERS-TENANT-GAP.md records why the deleted createMemberCode() should not
// be restored as it was. All three are avoided in allocateMemberCode() below:
//
//   1. It held a SESSION-scoped pg_advisory_lock on a pooled connection,
//      released only by an explicit unlock in a finally. If that unlock failed,
//      or the process died between lock and unlock, every subsequent member
//      creation blocked forever on a connection nobody could identify.
//      → pg_advisory_xact_lock, released by COMMIT or ROLLBACK unconditionally.
//
//   2. The code was generated on one pooled connection and the row inserted on
//      another, with the lock dropped in between, so two concurrent creates
//      could read the same last code and both use it.
//      → one transaction, one client, across both.
//
//   3. The code came from COUNT(*) + 1, which is not a sequence: delete one
//      member and the next code collides with one that already exists.
//      → MAX + 1 over the existing codes, the pattern src/db/id-gen.js
//        documents.
//
// One difference from the original, and it matters: the lock key is derived
// from the ORGANIZATION. The old one used a single global constant because
// there was no organization_id to key on and the sequence was global. Member
// codes are per-studio now (uq_members_org_code), so a global lock would
// serialise every studio's member creation against every other studio's for no
// reason. lib/subscription.js keys its lock by orgId for the same reason.

'use strict';

const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { memberSchemas } = require('../lib/validation');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');
const logger = require('../lib/logger');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Who may change the roster. Trainers read but do not write: assigning a
// trainer to a client is a PT-side action under /api/pt-os, and a trainer
// editing the gym's member records is not a workflow anyone asked for.
const canWrite = requireRole('admin', 'manager', 'reception');

const COLUMNS = `id, organization_id, member_code, name, mobile, email, dob, gender,
                 address, photo_url, emergency_contact, emergency_phone,
                 status, joined_on, source, notes, created_at, updated_at`;

/**
 * Append the caller's organization predicate to `params`, returning the SQL
 * fragment. Mirrors orgWhere() in modules/pt-os/pt-os.routes.js.
 */
function orgWhere(req, params, alias = '') {
  const scope = tenantScope(req);
  if (!scope.applyFilter) return '';
  params.push(scope.orgId);
  return ` AND ${alias}organization_id = $${params.length}`;
}

// Namespace for the member-code advisory lock, mixed in as the hash SEED
// rather than passed as a second lock argument.
//
// pg_advisory_xact_lock has exactly two forms: (bigint) and (integer, integer).
// There is no (bigint, integer), so the natural-looking
// `pg_advisory_xact_lock(hashtextextended($1, 0), NAMESPACE)` does not exist
// and raises 42883 the first time a member is created. Verified against
// Postgres 16. Seeding the hash instead keeps the namespacing and stays inside
// the single-bigint form.
const MEMBER_CODE_LOCK_NAMESPACE = 4266;

/**
 * Next member code for one organization. MUST be called on a client that has
 * already issued BEGIN — see the header note, and
 * src/__tests__/borrowedClientScope.convention.test.js, which fails the build
 * if a borrowed client runs outside a transaction.
 *
 * @param {import('pg').PoolClient} client transaction-bound client
 * @param {string} orgId
 */
async function allocateMemberCode(client, orgId) {
  // Transaction-scoped, so COMMIT or ROLLBACK always releases it — including
  // when the process dies mid-request. hashtextextended gives a stable bigint
  // key from the org uuid, seeded with the namespace above so this lock cannot
  // collide with an unrelated advisory lock that happens to hash the same way.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, $2))',
    [String(orgId), MEMBER_CODE_LOCK_NAMESPACE]);

  const { rows } = await client.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(member_code FROM 2) AS INTEGER)), 0) AS max_n
       FROM members
      WHERE organization_id = $1
        AND member_code ~ '^M[0-9]+$'`,
    [orgId]
  );
  // No deleted_at filter, deliberately. uq_members_org_code is partial on
  // deleted_at IS NULL, so a soft-deleted member's code COULD be reused without
  // violating it — but reusing a code that appears on a printed card or an old
  // receipt is worse than a gap in the sequence.
  return 'M' + String(Number(rows[0].max_n) + 1).padStart(5, '0');
}

// ── GET /api/members ────────────────────────────────────────────────────────
router.get('/', auth, wrap(async (req, res) => {
  const { status, search, source } = req.query;
  const conds = ['deleted_at IS NULL'];
  const params = [];

  const org = orgWhere(req, params);
  if (org) conds.push(org.replace(/^ AND /, ''));

  if (status) { params.push(status); conds.push(`status = $${params.length}`); }
  if (source) { params.push(source); conds.push(`source = $${params.length}`); }
  if (search) {
    // Name, mobile or member code. ILIKE on name is covered by
    // idx_members_name (organization_id, lower(name)) for the prefix case.
    params.push(`%${String(search).trim()}%`);
    conds.push(`(name ILIKE $${params.length} OR mobile ILIKE $${params.length} OR member_code ILIKE $${params.length})`);
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM members
      WHERE ${conds.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  // Total for pagination, same predicate minus limit/offset.
  const countParams = params.slice(0, params.length - 2);
  const { rows: [{ total }] } = await pool.query(
    `SELECT count(*)::int AS total FROM members WHERE ${conds.join(' AND ')}`,
    countParams
  );

  res.json({ data: rows, total, limit, offset });
}));

// ── GET /api/members/:id ────────────────────────────────────────────────────
//
// Includes the member's PT enrollments, which is the whole point of the
// separation: a member may have zero. An empty array here is a normal gym
// member, not an error.
router.get('/:id', auth, wrap(async (req, res) => {
  const params = [req.params.id];
  const org = orgWhere(req, params);

  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM members WHERE id = $1 AND deleted_at IS NULL${org}`, params
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found' } });

  // Scoped by member_id, which the query above has already proved belongs to
  // the caller's organization — the RELATIONSHIP pattern in
  // TENANT_SECURITY_AUDIT.md §1.2. pt_clients carries its own organization_id
  // too, so the predicate is added anyway rather than relying on the parent.
  const ptParams = [req.params.id];
  const ptOrg = orgWhere(req, ptParams);
  const { rows: enrollments } = await pool.query(
    `SELECT id, trainer_id, trainer_name, package_type, status,
            pt_start_date, pt_end_date, balance_amount
       FROM pt_clients
      WHERE member_id = $1 AND deleted_at IS NULL${ptOrg}
      ORDER BY created_at DESC`,
    ptParams
  );

  res.json({ data: { ...rows[0], pt_enrollments: enrollments } });
}));

// ── POST /api/members ───────────────────────────────────────────────────────
router.post('/', auth, canWrite, validate(memberSchemas.create), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  if (!orgId) {
    // A platform super admin operating platform-wide has no organization to
    // own the row. Refuse rather than create an org-less member, which is the
    // silent-data-loss shape 155_organization_id_not_null.sql exists to stop.
    return res.status(400).json({
      error: { code: 'ORG_REQUIRED', message: 'Select a studio before creating a member.' },
    });
  }

  const b = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const code = await allocateMemberCode(client, orgId);

    const { rows } = await client.query(
      `INSERT INTO members
         (organization_id, member_code, name, mobile, email, dob, gender, address,
          photo_url, emergency_contact, emergency_phone, status, joined_on, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING ${COLUMNS}`,
      [
        orgId, code, b.name, b.mobile || null, b.email || null, b.dob || null,
        b.gender || null, b.address || null, b.photo_url || null,
        b.emergency_contact || null, b.emergency_phone || null,
        b.status || 'active', b.joined_on || null, b.source || 'walk-in', b.notes || null,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // 23505 = unique_violation. uq_members_org_mobile is the one a user can
    // trip; report it as a conflict they can act on rather than a 500.
    if (err.code === '23505' && /uq_members_org_mobile/.test(err.constraint || '')) {
      return res.status(409).json({
        error: { code: 'MOBILE_EXISTS', message: 'A member with this mobile number already exists.' },
      });
    }
    throw err;
  } finally {
    client.release();
  }
}));

// ── PUT /api/members/:id ────────────────────────────────────────────────────
router.put('/:id', auth, canWrite, validate(memberSchemas.update), wrap(async (req, res) => {
  const allowed = ['name', 'mobile', 'email', 'dob', 'gender', 'address', 'photo_url',
    'emergency_contact', 'emergency_phone', 'status', 'joined_on', 'notes'];

  const sets = [];
  const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      params.push(req.body[key] === '' ? null : req.body[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: { code: 'NO_FIELDS', message: 'Nothing to update' } });
  sets.push('updated_at = NOW()');

  // The predicate is in the UPDATE's own WHERE, not in a preceding SELECT.
  // A guard that lives only in a lookup stops holding the first time somebody
  // reorders the handler.
  const org = orgWhere(req, params);

  try {
    const { rows } = await pool.query(
      `UPDATE members SET ${sets.join(', ')}
        WHERE id = $1 AND deleted_at IS NULL${org}
        RETURNING ${COLUMNS}`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
    res.json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505' && /uq_members_org_mobile/.test(err.constraint || '')) {
      return res.status(409).json({
        error: { code: 'MOBILE_EXISTS', message: 'A member with this mobile number already exists.' },
      });
    }
    throw err;
  }
}));

// ── DELETE /api/members/:id ─────────────────────────────────────────────────
//
// Soft delete, and refused while PT enrollments are attached.
//
// migration 166 declares pt_clients.member_id ON DELETE RESTRICT precisely so a
// hard delete cannot silently orphan a client's payments, sessions, assessments
// and progress. Soft deletion does not go through that constraint, so the same
// rule is enforced here — otherwise the member vanishes from the roster while
// their PT history stays live and unreachable.
router.delete('/:id', auth, requireRole('admin', 'manager'), wrap(async (req, res) => {
  const checkParams = [req.params.id];
  const checkOrg = orgWhere(req, checkParams);
  const { rows: [{ count }] } = await pool.query(
    `SELECT count(*)::int AS count FROM pt_clients
      WHERE member_id = $1 AND deleted_at IS NULL${checkOrg}`,
    checkParams
  );
  if (count > 0) {
    return res.status(409).json({
      error: {
        code: 'HAS_PT_ENROLLMENT',
        message: `This member has ${count} active PT enrollment${count === 1 ? '' : 's'}. End those first.`,
      },
    });
  }

  const params = [req.params.id];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE members SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL${org} RETURNING id`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found' } });

  logger.info({ memberId: req.params.id, by: req.user.id }, 'member soft-deleted');
  res.json({ data: { id: rows[0].id } });
}));

module.exports = router;
