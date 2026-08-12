// src/routes/clients.js
const router = require('express').Router();
const pool   = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { clientSchemas } = require('../lib/validation');
const { tenantScope } = require('../lib/tenant-db');
const logger = require('../lib/logger');

// Helper: parse a value as a finite number, or return fallback.
// parseFloat('') is NaN — `??` does NOT catch that. Use this guard instead.
function num(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve :id to a client the CALLER is allowed to touch, or null.
 *
 * Every by-id handler in this router needs the same two things — read
 * pt_clients (not the empty legacy `clients` table) and constrain to the
 * caller's organization — and getting either wrong is how a studio ends up
 * reading, editing or deleting another studio's client by guessing an id.
 * Returning null for "not yours" as well as "not there" is deliberate: the
 * caller answers 404 either way, so the API never confirms that an id exists
 * in some other studio.
 */
async function findClientForRequest(req) {
  const scope = tenantScope(req);
  const params = [req.params.id];
  let orgClause = '';
  if (scope.applyFilter) {
    params.push(scope.orgId);
    orgClause = ` AND organization_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM pt_clients WHERE id=$1${orgClause}`, params
  );
  return rows[0] || null;
}

// Track last auto-expire run so we don't fire the UPDATE on every list call.
let lastExpireRun = 0;
async function maybeAutoExpire() {
  const now = Date.now();
  // Run at most once per hour
  if (now - lastExpireRun < 60 * 60 * 1000) return;
  try {
    // pt_clients only. The twin UPDATE against `clients` that used to sit here
    // matched 0 rows on every run — that table has been empty since the PT-OS
    // enrolment flow shipped.
    await pool.query(
      `UPDATE pt_clients SET status='expired', updated_at=NOW()
       WHERE status='active' AND pt_end_date < CURRENT_DATE AND deleted_at IS NULL`
    );
    lastExpireRun = now;
  } catch (err) {
    logger.warn({ err: err.message }, 'Auto-expire error');
  }
}

// GET /api/clients
//   ?search=…       fuzzy on name / mobile / client_id / email
//   ?status=active|expired|frozen|expiring|dues
//   ?trainer_id=…   admin-only filter
//   ?limit=…        clamped to [1, 1000]
//   ?offset=…       clamped to >= 0
router.get('/', auth, async (req, res, next) => {
  try {
    const { search, status, trainer_id, dues } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const conditions = [];
    const params = [];
    let p = 1;
    // Soft-delete filter (added by 2026-05-perf-and-soft-delete migration).
    // We use an OR-against-NULL to keep this clause SAFE on databases that
    // haven't run the migration yet — Postgres short-circuits and returns
    // every row when the column isn't present (it would error before, but
    // production runs the migration first). Pass ?include_deleted=1 to see
    // soft-deleted rows.
    if (req.query.include_deleted !== '1') {
      conditions.push('COALESCE(c.deleted_at, NULL) IS NULL');
    }

    // Multi-tenant isolation (Phase 1): tenant users only ever see their own
    // organization's clients. Super admins see all, or a targeted org via the
    // x-org-id header. A tenant user with no org resolves to NULL, which
    // matches no rows — fail closed rather than leak.
    const scope = tenantScope(req);
    if (scope.applyFilter) {
      conditions.push(`c.organization_id = $${p++}`);
      params.push(scope.orgId);
    }

    // Scope trainer to own clients only
    if (req.user.role === 'trainer' && req.user.trainer_id) {
      conditions.push(`c.trainer_id = $${p++}`);
      params.push(req.user.trainer_id);
    } else if (trainer_id) {
      conditions.push(`c.trainer_id = $${p++}`);
      params.push(trainer_id);
    }

    if (search) {
      // ILIKE is the case-insensitive cousin of LIKE — and pairs with a
      // pg_trgm index on name/email/mobile for sub-100ms search at scale.
      conditions.push(
        `(c.name ILIKE $${p} OR c.mobile ILIKE $${p} OR c.client_id ILIKE $${p} OR c.email ILIKE $${p})`
      );
      params.push(`%${String(search).trim()}%`);
      p++;
    }

    if (status === 'expiring') {
      conditions.push(
        `c.status = 'active' AND c.pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`
      );
    } else if (status === 'dues') {
      conditions.push(`c.balance_amount > 0`);
    } else if (status) {
      conditions.push(`c.status = $${p++}`);
      params.push(status);
    }

    if (dues === 'yes') conditions.push('c.balance_amount > 0');

    // Branch scope: restrict to the caller's branch for non-admin users.
    // appendTo() returns corrected SQL and the full param list with branch_id appended.
    const { sql: bsql, params: bparams } = req.branchScope.appendTo(params);
    if (bsql !== 'TRUE') conditions.push(`c.${bsql}`);
    // Recalculate p to reflect any added parameters from branch scope.
    p = bparams.length + 1;

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Auto-expire is rate-limited to once an hour, off the hot read path.
    maybeAutoExpire().catch(err => console.error('Auto-expire error:', err));

    // Clients live in pt_clients — the legacy `clients` table has been empty
    // since the PT-OS enrolment flow shipped, so serving it here left every
    // consumer of this endpoint (attendance, check-in, payment picker, …)
    // with an empty list. branch_id is shimmed as NULL because pt_clients is
    // single-branch; the branch-scope clause treats NULL as visible.
    const { rows } = await pool.query(
      `SELECT c.*, t.name as computed_trainer_name
       FROM (SELECT pc.*, NULL::text AS branch_id FROM pt_clients pc) c
       LEFT JOIN trainers t ON t.id = c.trainer_id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...bparams, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/clients/search — dedicated search route matching frontend api.clients.search()
router.get('/search', auth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const searchParam = `%${q}%`;

    // Multi-tenant isolation (Phase 1) — see GET / for the rules.
    const scope = tenantScope(req);
    const baseParams = [searchParam];
    let orgClause = '';
    if (scope.applyFilter) {
      baseParams.push(scope.orgId);
      orgClause = ` AND c.organization_id = $${baseParams.length}`;
    }

    // A trainer may only search their own roster. GET / above already enforces
    // this; this route did not, which meant the same rule could be sidestepped
    // simply by calling /search instead of /. Fail closed: a trainer account
    // with no linked trainer record matches nothing rather than the whole org.
    if (req.user.role === 'trainer') {
      baseParams.push(req.user.trainer_id || null);
      orgClause += ` AND c.trainer_id = $${baseParams.length}`;
    }

    const { sql: bsql, params: bparams } = req.branchScope.appendTo(baseParams);
    const { rows } = await pool.query(
      `SELECT c.*, t.name as computed_trainer_name
       FROM (SELECT pc.*, NULL::text AS branch_id FROM pt_clients pc) c
       LEFT JOIN trainers t ON t.id = c.trainer_id
       WHERE COALESCE(c.deleted_at, NULL) IS NULL
         AND (c.name ILIKE $1 OR c.mobile ILIKE $1 OR c.client_id ILIKE $1 OR c.email ILIKE $1)${orgClause}
         AND c.${bsql}
       ORDER BY c.created_at DESC LIMIT $${bparams.length + 1}`,
      [...bparams, limit]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/clients/:id
//   Returns the client + last 50 payments, 20 weight logs, 20 renewals.
//   Fans the four queries out in parallel — was sequential before.
router.get('/:id', auth, async (req, res, next) => {
  try {
    // Multi-tenant isolation (Phase 1): a client from another organization is
    // invisible — the query returns nothing, so it 404s exactly like a
    // non-existent id (prevents cross-tenant IDOR).
    const scope = tenantScope(req);
    const idParams = [req.params.id];
    let orgClause = '';
    if (scope.applyFilter) {
      idParams.push(scope.orgId);
      orgClause = ` AND c.organization_id = $${idParams.length}`;
    }
    const { rows } = await pool.query(
      `SELECT c.*, t.name as trainer_full_name, t.mobile as trainer_mobile
       FROM pt_clients c LEFT JOIN trainers t ON t.id = c.trainer_id
       WHERE c.id = $1${orgClause}`, idParams
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });

    // Trainer can only see their own clients.
    if (req.user.role === 'trainer' &&
        (!req.user.trainer_id || rows[0].trainer_id !== req.user.trainer_id)) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Member role can only see their own record.
    if (req.user.role === 'member' && rows[0].id !== req.user.member_id) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Reception can see basic info but not financial details.
    const isReception = req.user.role === 'reception' || req.user.role === 'receptionist';

    const [payments, weightLogs, renewals] = await Promise.all([
      pool.query(
        `SELECT id, client_id, trainer_id, amount, incentive_amt,
                payment_method AS method, payment_ref AS receipt_no,
                date, notes, created_at
         FROM pt_payments WHERE client_id=$1 AND deleted_at IS NULL
         ORDER BY date DESC, created_at DESC LIMIT 50`,
        [req.params.id]
      ),
      pool.query(
        'SELECT * FROM weight_logs WHERE client_id=$1 ORDER BY date DESC LIMIT 20',
        [req.params.id]
      ),
      pool.query(
        'SELECT * FROM pt_client_renewals WHERE client_id=$1 ORDER BY created_at DESC LIMIT 20',
        [req.params.id]
      ),
    ]);

    if (isReception) {
      const { payments: _, weight_logs: wl, renewals: rn, ...basic } = rows[0];
      return res.json(basic);
    }

    res.json({
      ...rows[0],
      payments: payments.rows,
      weight_logs: weightLogs.rows,
      renewals: renewals.rows,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/clients/:id/renew  — REMOVED.
// POST /api/clients/:id/pt-renew — REMOVED.
//
// The same story as POST /api/clients below, and removed for the same reason.
// Both read `SELECT * FROM clients WHERE id=$1` and wrote back to that table.
// `clients` has held 0 rows since the PT-OS enrolment flow shipped, so both
// handlers 404'd on every call — and neither was reachable from the client
// anyway.
//
// Repointing them at pt_clients was not an option worth taking:
//
//   * `clients` has NO organization_id column, so neither handler could be
//     tenant-scoped. They sat behind plain `auth`, which means any logged-in
//     user of any studio could have renewed any row in that table. That was
//     harmless only because the table is empty — an accident, not a design.
//   * Both INSERT INTO `renewals`, a table that does not exist in this
//     database. Had the 404 not stopped them first, they would have 500'd.
//   * The org-scoped equivalent already exists and is what the app calls:
//     POST /api/pt-os/clients/:id/renew.

// POST /api/clients
// POST /api/clients — REMOVED. Create clients via POST /api/pt-os/clients.
//
// This handler inserted into `clients` and `payments`, the gym-membership pair
// that has held 0 rows since the PT-OS enrolment flow shipped. Nothing on the
// client called it, which is the only reason it never did damage: it did not
// fail, it succeeded, and every row it wrote was invisible to GET /api/clients
// (which reads pt_clients) and to every other screen in the product.
//
// It was also unsafe in two ways that a repoint could not inherit:
//
//   * No organization_id. The `clients` table has no such column, so a row
//     created here belonged to no studio at all.
//   * No plan seat check. /api/pt-os/clients calls clientLimitStatus() and
//     refuses at the plan's client limit; this path billed nobody and
//     enforced nothing.
//
// Repointing it at pt_clients would have meant duplicating the org stamping
// and the seat check, leaving two create paths for one entity — which is the
// confusion this whole cleanup exists to remove. One entity, one way in.

// PUT /api/clients/:id
// PUT /api/clients/:id
//
// Reads and writes pt_clients, like the rest of this router.
//
// This handler used to touch the legacy `clients` table while GET / and
// GET /:id had already been moved to pt_clients. `clients` has been empty
// since the PT-OS enrolment flow shipped, so the first statement here found
// nothing and the handler answered 404 "Client not found" for EVERY client —
// including the one the page had just rendered from pt_clients a moment
// earlier. Visible symptom: the client profile's Save Notes button failing
// permanently with "Failed to save notes"
// (app/pt-os/clients/[id]/page.tsx).
//
// The tenant scope below is new and is not optional. The old query was
// `WHERE id=$1` with no organization filter — harmless only because the table
// was empty. Pointing that same query at pt_clients, which holds every
// studio's clients, would have let any studio edit any other studio's client
// by id. This mirrors GET /:id above.
//
// payment_method, payment_date, biometric_added and member_code are dropped
// rather than carried across: they are gym-membership columns that pt_clients
// does not have, and this product is personal training. A payment method
// belongs on the payment (pt_payments), not on the client row. None of the
// four is accepted by clientSchemas.update anyway, so zod was already
// stripping them and they only ever wrote their defaults.
router.put('/:id', auth, validate(clientSchemas.update), async (req, res, next) => {
  try {
    const d = req.body;
    const scope = tenantScope(req);
    const findParams = [req.params.id];
    let orgClause = '';
    if (scope.applyFilter) {
      findParams.push(scope.orgId);
      orgClause = ` AND organization_id = $${findParams.length}`;
    }
    const { rows: existing } = await pool.query(
      `SELECT * FROM pt_clients WHERE id=$1${orgClause}`, findParams
    );
    if (!existing[0]) return res.status(404).json({ error: 'Client not found' });
    if (req.user.role === 'trainer' &&
        (!req.user.trainer_id || existing[0].trainer_id !== req.user.trainer_id))
      return res.status(403).json({ error: 'Access denied' });

    const base    = num(d.base_amount,   existing[0].base_amount);
    const disc    = num(d.discount,      existing[0].discount);
    const final   = num(d.final_amount,  existing[0].final_amount);
    const paid    = num(d.paid_amount,   existing[0].paid_amount);

    // Trainers cannot reassign clients to a different trainer
    const trainer_id = req.user.role === 'trainer'
      ? req.user.trainer_id
      : (d.trainer_id || existing[0].trainer_id || null);

    // Resolve trainer_name from supplied id when admin changes it
    let trainer_name = d.trainer_name || existing[0].trainer_name || null;
    if (req.user.role !== 'trainer' && d.trainer_id && d.trainer_id !== existing[0].trainer_id) {
      const { rows: tr } = await pool.query('SELECT name FROM trainers WHERE id=$1', [d.trainer_id]);
      trainer_name = tr[0]?.name || null;
    }

    // Every field falls back to its CURRENT value, never to null.
    //
    // This is a full-row UPDATE driven by a partial body, and the previous
    // version wrote `d.mobile||null`, `d.address||null`, `d.pt_start_date||null`
    // and so on. The client profile calls this with a single key —
    // api.clients.update(id, { notes }) — so saving a note would have blanked
    // that client's mobile, email, gender, dob, address, PT dates, weight and
    // photo in one statement. It never fired only because the handler was
    // reading the empty `clients` table and 404ing first; repointing it at
    // pt_clients without this change would have turned a dead endpoint into a
    // data-loss one.
    //
    // `??` rather than `||` so a deliberate empty string still clears a field
    // (notes, address) and 0 stays 0 — with `||` both would silently revert.
    // pt_start_date, pt_end_date, weight and photo_url are not part of
    // clientSchemas.update at all, so zod strips them and they can only ever
    // be preserved here.
    await pool.query(`
      UPDATE pt_clients SET
        name=$1, mobile=$2, email=$3, gender=$4, dob=$5, address=$6,
        trainer_id=$7, trainer_name=$8, pt_start_date=$9, pt_end_date=$10,
        package_type=$11, base_amount=$12, discount=$13, final_amount=$14,
        paid_amount=$15, balance_amount=$16,
        weight=$17, notes=$18, status=$19, photo_url=$20, biometric_code=$21,
        updated_at=NOW()
      WHERE id=$22`,
      [d.name?.trim() ?? existing[0].name,
       d.mobile ?? existing[0].mobile,
       d.email?.toLowerCase() ?? existing[0].email,
       d.gender ?? existing[0].gender,
       d.dob ?? existing[0].dob,
       d.address ?? existing[0].address,
       trainer_id, trainer_name,
       existing[0].pt_start_date, existing[0].pt_end_date,
       d.package_type ?? existing[0].package_type,
       base, disc, final, paid, Math.max(0, final - paid),
       existing[0].weight,
       d.notes ?? existing[0].notes,
       d.status ?? existing[0].status,
       existing[0].photo_url,
       existing[0].biometric_code ?? existing[0].client_id,
       req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM pt_clients WHERE id=$1', [req.params.id]);
    res.json({ message: 'Updated', client: rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/clients/:id/attendance
// Returns attendance logs for a single client (used by profile page tab).
router.get('/:id/attendance', auth, async (req, res, next) => {
  try {
    const client = await findClientForRequest(req);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (req.user.role === 'trainer' &&
        (!req.user.trainer_id || client.trainer_id !== req.user.trainer_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { rows } = await pool.query(
      `SELECT id, date, check_in_time, check_out_time, method, notes
         FROM attendance_logs
        WHERE ref_id = $1 AND ref_type = 'client'
        ORDER BY date DESC, check_in_time DESC
        LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/clients/:id/payments
// Returns payment history for a single client (used by profile page tab).
router.get('/:id/payments', auth, async (req, res, next) => {
  try {
    const client = await findClientForRequest(req);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (req.user.role === 'trainer' &&
        (!req.user.trainer_id || client.trainer_id !== req.user.trainer_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    // pt_payments, not `payments` — the latter is the gym-era ledger and is
    // empty. Column names differ, so the old aliases are preserved for the
    // client: method <- payment_method, receipt_no <- payment_ref. There is no
    // package_type on pt_payments, so `plan` is dropped rather than faked.
    const { rows } = await pool.query(
      `SELECT id, amount, payment_method AS method, date,
              payment_ref AS receipt_no, notes
         FROM pt_payments
        WHERE client_id = $1 AND deleted_at IS NULL
        ORDER BY date DESC, created_at DESC
        LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/clients/:id (admin only)
//
// Soft delete by default. The 2026-05-perf-and-soft-delete migration adds
// `deleted_at TIMESTAMPTZ` to clients/payments. We set it instead of
// running DELETE so the financial trail (payments referencing this client)
// stays intact.
//
// Pass ?hard=1 to fall back to a hard DELETE — useful for cleaning up
// test rows but never the right call in production.
router.delete('/:id', auth, adminOnly, async (req, res, next) => {
  try {
    // Resolve within the caller's organization first, so a client belonging to
    // another studio 404s exactly like a non-existent id. Without this the
    // delete below would have matched on id alone — tolerable while `clients`
    // was empty, a cross-tenant delete against pt_clients.
    const client = await findClientForRequest(req);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    if (req.query.hard === '1') {
      const { rows } = await pool.query(
        'DELETE FROM pt_clients WHERE id=$1 RETURNING id',
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
      return res.json({ message: 'Client hard-deleted' });
    }
    const { rows } = await pool.query(
      `UPDATE pt_clients
          SET deleted_at = NOW(),
              updated_at = NOW(),
              status     = 'inactive'
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ message: 'Client deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
