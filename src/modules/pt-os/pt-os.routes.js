const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../../db/pool');
const { auth, adminOnly, adminOrManager } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const logger = require('../../lib/logger');
const svc = require('./pt-os.service');
const { orgIdOf, tenantScope } = require('../../lib/tenant-db');
const { today: studioToday } = require('../../lib/appTime');
const subscription = require('../../lib/subscription');
const { buildBrief } = require('./training-brief');
const { buildEnrollmentPdf } = require('../../lib/ptEnrollmentPdf');
const { buildSnapshot } = require('./client-snapshot');
const { generateCoach } = require('./coach-ai');
const { buildRecovery } = require('./recovery');
const { routedChat } = require('../../lib/ai/router');
const { logActivity } = require('../../lib/activityLog');

const ptClientCreateSchema = {
  body: z.object({
    name: z.string().min(1).max(255),
    mobile: z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian mobile number').optional().nullable(),
    email: z.string().email().optional().nullable(),
    dob: z.string().optional().nullable(),
    gender: z.string().max(20).optional().nullable(),
    trainer_id: z.string().uuid().optional().nullable(),
    trainer_name: z.string().max(255).optional().nullable(),
    goal: z.string().max(100).optional().nullable(),
    height: z.coerce.number().optional().nullable(),
    weight: z.coerce.number().optional().nullable(),
    body_fat: z.coerce.number().optional().nullable(),
    health_conditions: z.string().max(500).optional().nullable(),
    injuries: z.string().max(500).optional().nullable(),
    frequency: z.string().max(50).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    monthly_pt_amount: z.coerce.number().optional().nullable(),
    base_amount: z.coerce.number().optional().nullable(),
    discount: z.coerce.number().optional().nullable(),
    pt_start_date: z.string().optional().nullable(),
    pt_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(d => !isNaN(Date.parse(d)), 'Invalid date').optional().nullable(),
    pt_package_id: z.string().optional().nullable(),
    client_id: z.string().optional().nullable(),
    package_type: z.string().optional().nullable(),
    duration_months: z.coerce.number().optional().nullable(),
    base_price: z.coerce.number().optional().nullable(),
    selling_price: z.coerce.number().optional().nullable(),
    whatsapp: z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian mobile number').optional().nullable(),
    occupation: z.string().max(100).optional().nullable(),
    emergency_contact: z.string().max(255).optional().nullable(),
    emergency_phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian mobile number').optional().nullable(),
    address: z.string().max(1000).optional().nullable(),
  }),
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Tenant-scope predicate for by-id / aggregate pt_clients queries. Appends the
// caller's org id to `params` and returns ` AND <col> = $N`; for a platform
// super admin operating platform-wide it returns '' (no filter, sees all).
// Every read/write that targets a client by id must AND this in, otherwise one
// studio can read, edit, or delete another studio's rows (cross-tenant IDOR).
/**
 * How an enrolling payment was taken.
 *
 * A closed set rather than free text: this column is read back by finance
 * screens that group by it, and "UPI", "upi" and "Upi " are three payment
 * methods to a GROUP BY and one to a human.
 */
const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'SPLIT'];

function orgWhere(req, params, col = 'organization_id') {
  const scope = tenantScope(req);
  if (!scope.applyFilter) return '';
  params.push(scope.orgId);
  return ` AND ${col} = $${params.length}`;
}

// True if `clientId` belongs to the caller's org (always true for a platform
// super admin operating platform-wide). Used to gate reads of a client's
// child records (renewals, communication, subscriptions) whose own tables
// carry no organization_id — the tenant boundary is the parent client.
async function clientInOrg(req, clientId) {
  const params = [clientId];
  const orgClause = orgWhere(req, params);
  const { rowCount } = await pool.query(
    `SELECT 1 FROM pt_clients WHERE id = $1 AND deleted_at IS NULL${orgClause}`,
    params
  );
  return rowCount > 0;
}

// ─── Trainers ───────────────────────────────────────────────
router.get('/trainers', auth, wrap(async (req, res) => {
  // Include trainers from both the main trainers table and the PT-OS-specific
  // pt_trainers table so adding a trainer in either place makes them available here.
  //
  // Scoped by organization. This route had no tenant filter at all, so every
  // studio saw every trainer on the platform — the Book PT Session dialog
  // listed four trainers from four different studios — and the payload carried
  // email, mobile, specialization and incentive_rate with them, which is one
  // studio's commission terms readable by its competitors. Every sibling route
  // in this file already scopes with tenantScope(req); this one was the outlier.
  //
  // NULL organization_id is excluded rather than treated as shared: an
  // unattributable trainer shown to every studio is exactly the bug being
  // fixed. Migration 143 backfills what it can and reports what it cannot.
  const scope = tenantScope(req);
  const params = [];
  let orgFilter = '';
  if (scope.applyFilter) {
    params.push(scope.orgId);
    orgFilter = `AND organization_id = $${params.length}`;
  }

  const { rows } = await pool.query(`
    SELECT id, name, email, mobile, specialization, incentive_rate, status, NULL::text AS photo_url
    FROM trainers
    WHERE deleted_at IS NULL AND status = 'active' ${orgFilter}
    UNION
    SELECT id, name, email, mobile, specialization, incentive_rate, status, photo_url
    FROM pt_trainers
    WHERE deleted_at IS NULL AND status = 'active' ${orgFilter}
    ORDER BY name
  `, params);
  res.json({ data: rows });
}));

router.post('/trainers', auth, adminOnly, wrap(async (req, res) => {
  const { name, email, mobile, specialization, incentive_rate } = req.body;
  // Insert into the canonical trainers table (not pt_trainers): pt_clients
  // assignments and the pt_payments.trainer_id FK both resolve against
  // trainers, so a trainer created here must land there to be usable.
  // organization_id is stamped at creation. Without it the trainer is created
  // org-less, and now that the GET above filters on organization_id, an
  // org-less trainer is invisible to the very studio that just created them —
  // the create would appear to silently do nothing.
  const scope = tenantScope(req);
  const { rows } = await pool.query(
    `INSERT INTO trainers (name, email, mobile, specialization, incentive_rate, status, organization_id)
     VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING *`,
    [name, email, mobile, specialization, incentive_rate ?? 0.5, scope.orgId]
  );
  res.status(201).json({ data: rows[0] });
}));

// ─── Dashboard stats ─────────────────────────────────────────
router.get('/dashboard', auth, wrap(async (req, res) => {
  const stats = await svc.getDashboardStats(tenantScope(req));
  res.json({ data: stats });
}));

// ─── Active PT clients ───────────────────────────────────────
router.get('/clients', auth, wrap(async (req, res) => {
  const trainerId = req.query.trainer_id;
  const tid = req.user.role === 'trainer' ? req.user.trainer_id : trainerId;
  const rows = await svc.getActiveClients(tid, tenantScope(req));
  res.json({ data: rows, total: rows.length });
}));

// ─── Duplicate Client Audit (MUST be before /clients/:id) ───
router.get('/clients/duplicates', auth, adminOnly, wrap(async (req, res) => {
  const params = [];
  const orgClause = orgWhere(req, params);
  const { rows } = await pool.query(`
    SELECT
      TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))) AS normalized_name,
      (ARRAY_AGG(name ORDER BY created_at ASC))[1] AS display_name,
      COUNT(*)::int AS record_count,
      MIN(created_at)::date AS first_seen,
      ARRAY_AGG(pt_start_date ORDER BY pt_start_date NULLS LAST)
        FILTER (WHERE pt_start_date IS NOT NULL) AS subscription_starts,
      SUM(final_amount)::numeric AS total_final,
      SUM(paid_amount)::numeric  AS total_paid,
      GREATEST(0, SUM(final_amount) - SUM(paid_amount))::numeric AS balance,
      (ARRAY_AGG(id ORDER BY created_at ASC))[1] AS master_id,
      ARRAY_AGG(id ORDER BY created_at ASC) AS all_ids,
      (ARRAY_AGG(mobile ORDER BY created_at ASC NULLS LAST)
        FILTER (WHERE mobile IS NOT NULL AND mobile != ''))[1] AS mobile,
      (ARRAY_AGG(package_type ORDER BY pt_start_date DESC NULLS LAST)
        FILTER (WHERE package_type IS NOT NULL))[1] AS latest_plan,
      (ARRAY_AGG(trainer_name ORDER BY pt_start_date DESC NULLS LAST)
        FILTER (WHERE trainer_name IS NOT NULL))[1] AS trainer_name
    FROM pt_clients
    WHERE deleted_at IS NULL${orgClause}
    GROUP BY TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g')))
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC, normalized_name
  `, params);
  res.json({
    data: rows,
    total_groups: rows.length,
    total_records: rows.reduce((s, r) => s + r.record_count, 0),
    total_duplicates: rows.reduce((s, r) => s + r.record_count - 1, 0),
    total_financial_value: rows.reduce((s, r) => s + Number(r.total_final), 0),
  });
}));

// Feb 29 only exists every 4th year — re-applying a Feb-29 birth date to an
// arbitrary year needs to fall back to Feb 28 in the years that aren't leap
// years. Every other month/day pair is always valid in every year, so this
// is the one case that needs special-casing.
const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// Days from `todayUTC` to the next occurrence of `birthMonth`/`birthDay`
// (0 if today IS the birthday), plus the age the client turns that day.
// All math is done in UTC on date-only values (no time-of-day component) so
// it is not sensitive to server timezone.
function nextBirthday(birthMonth, birthDay, birthYear, todayUTC) {
  const y = todayUTC.getUTCFullYear();
  const dayIn = (year) => (birthMonth === 2 && birthDay === 29 && !isLeapYear(year)) ? 28 : birthDay;
  let next = Date.UTC(y, birthMonth - 1, dayIn(y));
  if (next < todayUTC.getTime()) next = Date.UTC(y + 1, birthMonth - 1, dayIn(y + 1));
  const days_until = Math.round((next - todayUTC.getTime()) / 86400000);
  const turning_age = new Date(next).getUTCFullYear() - birthYear;
  return { days_until, turning_age };
}

// ─── Client birthdays (MUST be before /clients/:id) ──────────
router.get('/clients/birthdays', auth, wrap(async (req, res) => {
  const trainerId = req.user.role === 'trainer' ? req.user.trainer_id : req.query.trainer_id;
  const params = [];
  // Qualified, because this query joins trainers and BOTH tables carry an
  // organization_id. Unqualified, Postgres cannot resolve which one is meant
  // and throws "column reference organization_id is ambiguous" — a 500 on
  // every single call. It threw 49 times in one day before anybody noticed,
  // because the only thing it broke was a page nobody had open.
  const orgClause = orgWhere(req, params, 'c.organization_id');
  let trainerClause = '';
  if (trainerId) {
    params.push(trainerId);
    trainerClause = ` AND c.trainer_id = $${params.length}`;
  }
  const [{ rows: todayRows }, { rows }] = await Promise.all([
    pool.query('SELECT CURRENT_DATE AS today'),
    pool.query(`
      SELECT c.id, c.name, c.mobile, c.email, c.photo_url, c.dob, c.status,
             c.trainer_id, COALESCE(t.name, c.trainer_name) AS trainer_name
      FROM pt_clients c
      LEFT JOIN trainers t ON t.id = c.trainer_id
      WHERE c.deleted_at IS NULL AND c.dob IS NOT NULL${orgClause}${trainerClause}
      ORDER BY c.name
    `, params),
  ]);

  const todayUTC = new Date(todayRows[0].today);
  const enriched = rows.map((c) => {
    const dob = new Date(c.dob);
    const { days_until, turning_age } = nextBirthday(
      dob.getUTCMonth() + 1, dob.getUTCDate(), dob.getUTCFullYear(), todayUTC,
    );
    return { ...c, days_until_birthday: days_until, turning_age, is_today: days_until === 0 };
  }).sort((a, b) => a.days_until_birthday - b.days_until_birthday || a.name.localeCompare(b.name));

  res.json({ data: enriched, total: enriched.length, today_count: enriched.filter((c) => c.is_today).length });
}));

// ─── Single client details ──────────────────────────────────
// ─── Enrolment form as a PDF (MUST be before /clients/:id) ──────────
//
// Streamed, not stored. The document is built from live client columns, so a
// saved copy would be a stale copy of a query and the studio would eventually
// download last month's version of this month's enrolment.
router.get('/clients/:id/enrollment-pdf', auth, wrap(async (req, res) => {
  const params = [req.params.id];
  const orgClause = orgWhere(req, params, 'c.organization_id');
  const { rows } = await pool.query(
    `SELECT c.* FROM pt_clients c WHERE c.id = $1 AND c.deleted_at IS NULL${orgClause}`,
    params,
  );
  const client = rows[0];
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const buffer = await buildEnrollmentPdf(client, req.user?.organization_name);

  // A filename the studio can find again in a downloads folder six weeks
  // later. Non-filename characters out, because a client called "Priya
  // (Mon/Wed)" would otherwise produce a path, not a name.
  const safeName = String(client.name || 'client').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Content-Disposition', `attachment; filename="pt-enrolment-${safeName || 'client'}.pdf"`);
  res.send(buffer);
}));

router.get('/clients/:id', auth, wrap(async (req, res) => {
  const params = [req.params.id];
  const orgClause = orgWhere(req, params, 'c.organization_id');
  const { rows } = await pool.query(`
    SELECT c.*,
           CASE
             WHEN c.pt_end_date IS NOT NULL AND c.pt_end_date::TEXT != ''
             THEN c.pt_end_date::DATE - CURRENT_DATE
             ELSE NULL
           END AS days_left,
           COALESCE(pp.total_incentives, 0) AS total_earned_commission,
           CASE
             WHEN c.balance_amount > 0
              AND c.pt_end_date IS NOT NULL AND c.pt_end_date::TEXT != ''
              AND c.pt_end_date::DATE < CURRENT_DATE THEN 'OVERDUE'
             WHEN c.balance_amount > 0 THEN 'DUE'
             ELSE 'CLEAR'
           END AS due_status
    FROM pt_clients c
    LEFT JOIN (
      SELECT client_id, SUM(incentive_amt) AS total_incentives
      FROM pt_payments
      WHERE deleted_at IS NULL
      GROUP BY client_id
    ) pp ON pp.client_id = c.id
    WHERE c.id = $1 AND c.deleted_at IS NULL${orgClause}
  `, params);
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  res.json({ data: rows[0] });
}));

// ─── Create / enroll client in PT ───────────────────────────
router.post('/clients', auth, requireRole('admin','manager','trainer'), validate(ptClientCreateSchema), wrap(async (req, res) => {
      try {
        const {
          client_id, name, gender, mobile, email, dob,
          trainer_id, trainer_name: reqTrainerName, package_type, base_amount, discount,
          pt_start_date, pt_end_date, duration_months, monthly_pt_amount,
          notes, weight,
          goal, height, body_fat, health_conditions, injuries, frequency,
          pt_package_id,
          whatsapp, occupation, emergency_contact, emergency_phone, address,
        } = req.body;

    let cid = client_id;
    if (!cid) {
      // Plan client-limit enforcement (SaaS). Adding a brand-new client to the
      // roster is blocked once the studio hits its plan's client limit; existing
      // clients stay fully accessible. Unlimited plans (limit null) never block.
      const { limit, count, atLimit } = await subscription.clientLimitStatus(orgIdOf(req));
      if (atLimit) {
        return res.status(403).json({
          error: {
            code: 'PLAN_LIMIT_REACHED',
            message: `You've reached your plan's limit of ${limit} clients. Upgrade your plan to add more.`,
            limit, count,
          },
        });
      }

      // Multi-tenant isolation (Phase 1): stamp the creator's organization so
      // the new client is only ever visible within that tenant's workspace.
      const { rows: [newCli] } = await pool.query(`
        INSERT INTO pt_clients
          (name, gender, mobile, email, dob, status, joining_date,
           whatsapp, occupation, emergency_contact, emergency_phone, address, organization_id)
        VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12)
        RETURNING id
      `, [
        name, gender || null, mobile || null, email || null, dob || null, pt_start_date || new Date(),
        whatsapp || null, occupation || null, emergency_contact || null, emergency_phone || null, address || null,
        orgIdOf(req),
      ]);
      cid = newCli.id;
    }

    const finalAmt = (base_amount || 0) - (discount || 0);

    // Trainer name: use value sent directly by frontend first, then fall back to DB lookup
    let resolvedTrainerName = reqTrainerName || null;
    if (!resolvedTrainerName && trainer_id) {
      const { rows: tRows } = await pool.query(
        `SELECT name FROM trainers WHERE id = $1
         UNION
         SELECT name FROM pt_trainers WHERE id = $1
         LIMIT 1`, [trainer_id]
      );
      resolvedTrainerName = tRows[0]?.name || null;
    }

    // Resolve plan name / duration from the selected package when not sent directly
    let resolvedPackageType = package_type || null;
    let resolvedDurationMonths = duration_months || null;
    if (pt_package_id && (!resolvedPackageType || !resolvedDurationMonths)) {
      const { rows: [plan] } = await pool.query(
        'SELECT name, duration_months FROM pt_plans WHERE id = $1', [pt_package_id]
      );
      if (plan) {
        resolvedPackageType = resolvedPackageType || plan.name;
        resolvedDurationMonths = resolvedDurationMonths || plan.duration_months;
      }
    }

    const startDate = pt_start_date || studioToday();
    let endDate = pt_end_date || null;
    if (!endDate && resolvedDurationMonths && resolvedDurationMonths > 0) {
      const d = new Date(startDate);
      d.setMonth(d.getMonth() + Number(resolvedDurationMonths));
      endDate = d.toISOString().slice(0, 10);
    }

    const { rows } = await pool.query(`
      UPDATE pt_clients SET
        trainer_id        = COALESCE($2,  trainer_id),
        trainer_name      = COALESCE($3,  trainer_name),
        package_type      = COALESCE($4,  package_type),
        base_amount       = COALESCE($5,  base_amount),
        discount          = COALESCE($6,  discount),
        final_amount      = COALESCE($7,  final_amount),
        balance_amount    = GREATEST(COALESCE($7, final_amount) - paid_amount, 0),
        monthly_pt_amount = COALESCE($8,  monthly_pt_amount),
        pt_start_date     = COALESCE($9,  pt_start_date),
        pt_end_date       = COALESCE($10, pt_end_date),
        duration_months   = COALESCE($11, duration_months),
        notes             = COALESCE($12, notes),
        weight            = COALESCE($13, weight),
        goal              = COALESCE($14, goal),
        height            = COALESCE($15, height),
        body_fat          = COALESCE($16, body_fat),
        health_conditions = COALESCE($17, health_conditions),
        injuries          = COALESCE($18, injuries),
        frequency         = COALESCE($19, frequency),
        -- Promote to 'active' only once the client is actually enrolled in a
        -- package (has an end date, a charged amount, or a duration). A name-only
        -- add stays 'pending' so it never shows in the active-clients list/counts.
        -- Existing enrolled clients keep 'active' since COALESCE preserves their
        -- stored package fields even when this edit doesn't touch them.
        status = CASE
          WHEN COALESCE($10, pt_end_date) IS NOT NULL
            OR COALESCE($7, final_amount) > 0
            OR COALESCE($11, duration_months) > 0
          THEN 'active'
          ELSE status
        END,
        updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
    `, [
      cid,
      trainer_id, resolvedTrainerName, resolvedPackageType,
      base_amount, discount, finalAmt, monthly_pt_amount,
      startDate, endDate, resolvedDurationMonths,
      notes || null, weight != null ? Number(weight) : null,
      goal || null, height != null ? Number(height) : null,
      body_fat != null ? Number(body_fat) : null,
      health_conditions || null, injuries || null, frequency || null,
    ]);

    await logActivity(req, 'client.create', 'pt_client', rows[0].id, rows[0]);
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    logger.error({ err: err.message, body: req.body, user: req.user?.id }, 'PT OS create client failed');
    throw err;
  }
}));

// ─── Renewal history for a client ───────────────────────────
router.get('/clients/:id/renewals', auth, wrap(async (req, res) => {
  if (!await clientInOrg(req, req.params.id))
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const { rows } = await pool.query(
    `SELECT * FROM pt_client_renewals WHERE client_id = $1 ORDER BY renewed_at DESC`,
    [req.params.id]
  );
  res.json({ data: rows });
}));

// ─── Renew PT client ────────────────────────────────────────
router.post('/clients/:id/renew', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const d = req.body;
  if (!d.pt_start_date || !d.duration_months)
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'pt_start_date and duration_months are required' } });

  const endDate = new Date(d.pt_start_date);
  endDate.setMonth(endDate.getMonth() + Number(d.duration_months));
  const ptEndDate = endDate.toISOString().slice(0, 10);

  const baseAmt    = Number(d.base_amount)       || 0;
  const disc       = Number(d.discount)           || 0;
  const finalAmt   = d.final_amount !== undefined ? Number(d.final_amount) : Math.max(baseAmt - disc, 0);
  const paidNow    = Number(d.paid_amount)        || 0;
  const monthlyAmt = Number(d.monthly_pt_amount)  || 0;
  const packageType = d.package_type || null;

  const exParams = [req.params.id];
  const exOrg = orgWhere(req, exParams);
  const { rows: existing } = await pool.query(
    `SELECT * FROM pt_clients WHERE id = $1 AND deleted_at IS NULL${exOrg}`,
    exParams
  );
  if (existing.length === 0)
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const c = existing[0];

  const { rows } = await pool.query(`
    UPDATE pt_clients SET
      package_type      = COALESCE($2, package_type),
      base_amount       = $3,
      discount          = $4,
      final_amount      = $5,
      monthly_pt_amount = $6,
      pt_start_date     = $7,
      pt_end_date       = $8,
      duration_months   = $9,
      paid_amount       = paid_amount + $10,
      balance_amount    = GREATEST($5 - (paid_amount + $10), 0),
      status            = 'active',
      updated_at        = NOW()
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING *
  `, [req.params.id, packageType, baseAmt, disc, finalAmt, monthlyAmt,
      d.pt_start_date, ptEndDate, d.duration_months, paidNow]);

  // Log to renewal history
  await pool.query(`
    INSERT INTO pt_client_renewals
      (client_id, client_name, trainer_name, old_package, new_package,
       old_end_date, new_start_date, new_end_date, duration_months,
       base_amount, discount, final_amount, paid_amount, balance_amount, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  `, [
    req.params.id, c.name, c.trainer_name,
    c.package_type, packageType || c.package_type,
    c.pt_end_date, d.pt_start_date, ptEndDate, d.duration_months,
    baseAmt, disc, finalAmt, paidNow, Math.max(finalAmt - paidNow, 0),
    d.notes || null,
  ]);

  // Also write to pt_client_subscriptions (canonical term history used by the profile page)
  await pool.query(`
    INSERT INTO pt_client_subscriptions
      (client_id, plan_name, start_date, end_date, duration_months,
       selling_price, amount_paid, balance_amount, trainer_name, status, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','renewal')
    ON CONFLICT DO NOTHING
  `, [
    req.params.id,
    packageType || c.package_type,
    d.pt_start_date, ptEndDate, d.duration_months,
    finalAmt, paidNow, Math.max(finalAmt - paidNow, 0),
    c.trainer_name,
  ]);

  // Ledger: money collected at renewal must land in pt_payments — the revenue
  // reports sum the payment ledgers, not pt_clients.paid_amount, so without
  // this row renewal income was invisible to every financial report.
  if (paidNow > 0) {
    let ledgerTrainerId = null;
    let incentiveRate = 0;
    if (c.trainer_id) {
      const { rows: tr } = await pool.query(
        'SELECT id, incentive_rate FROM trainers WHERE id=$1', [c.trainer_id]
      );
      if (tr[0]) { ledgerTrainerId = tr[0].id; incentiveRate = tr[0].incentive_rate ?? 0.5; }
    }
    await pool.query(
      `INSERT INTO pt_payments (client_id, trainer_id, amount, incentive_amt, payment_method, date, notes, organization_id)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7)`,
      [req.params.id, ledgerTrainerId, paidNow, Math.round(paidNow * incentiveRate),
       String(d.payment_method || 'CASH').toUpperCase(), `Renewal — ${packageType || c.package_type || 'PT package'}`,
       orgIdOf(req)]
    );
  }

  res.json({ data: rows[0] });
}));

// ─── Update PT client ───────────────────────────────────────
router.patch('/clients/:id', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const isTrainer = req.user.role === 'trainer';
  // Payment fields are handled separately below (validated + balance_amount
  // auto-computed) rather than through the generic allowlist loop, and stay
  // admin/manager-only — trainers were never allowed to set these, unchanged.
  const allowed = isTrainer
    ? ['package_type','trainer_id','trainer_name','pt_start_date','pt_end_date',
       'duration_months','status','notes','monthly_pt_amount',
       'goal','height','body_fat','health_conditions','injuries','frequency',
       'training_mode','preferred_workout_time','preferred_training_days','sessions_per_week',
       'workout_experience_level','previous_trainer_experience',
       'agreement_accepted_at','agreement_signature','agreement_text']
    : ['package_type','base_amount','discount',
       'monthly_pt_amount','trainer_id','trainer_name','pt_start_date','pt_end_date',
       'duration_months','status','notes',
       'name','email','mobile','gender','dob','address','weight','photo_url','emergency_contact','emergency_phone',
       'goal','height','body_fat','health_conditions','injuries','frequency',
       'training_mode','preferred_workout_time','preferred_training_days','sessions_per_week',
       'workout_experience_level','previous_trainer_experience',
       'agreement_accepted_at','agreement_signature','agreement_text',
       // Money-adjacent, so admin/manager only — same boundary as
       // final_amount and paid_amount above it.
       'payment_method'];

  // A free-text payment method is a reporting column nobody can group by.
  if (req.body.payment_method !== undefined && req.body.payment_method !== null) {
    if (!PAYMENT_METHODS.includes(String(req.body.payment_method))) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}` },
      });
    }
  }

  const wantsFinalAmount = !isTrainer && req.body.final_amount !== undefined;
  const wantsPaidAmount  = !isTrainer && req.body.paid_amount !== undefined;

  let finalAmount = null;
  let paidAmount = null;
  let previousPaid = null;
  if (wantsFinalAmount || wantsPaidAmount) {
    // Validate the two fields together against whichever value isn't being
    // changed in this request — never trust the client to have already
    // enforced paid <= final; recompute and re-check server-side.
    const exParams = [req.params.id];
    const exOrg = orgWhere(req, exParams);
    const { rows: existingRows } = await pool.query(
      `SELECT final_amount, paid_amount FROM pt_clients WHERE id = $1 AND deleted_at IS NULL${exOrg}`,
      exParams
    );
    if (existingRows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
    const existing = existingRows[0];
    previousPaid = Number(existing.paid_amount) || 0;

    if (wantsFinalAmount) {
      // `>= 0`, not `> 0`. This rejected every save on a client priced at zero
      // — and the edit form posts the whole form, so a trainer correcting a
      // phone number re-sent final_amount and got "Final Selling Price must be
      // greater than zero" for a field they never touched. Two ways in, both
      // real: a stored 0 posts as 0, and a stored NULL renders as an empty
      // input and posts as null, which Number() also makes 0.
      //
      // A price of zero is legitimate anyway — complimentary, trial, founding
      // member — so the rule was wrong on its own terms as well as unreachable
      // to satisfy. "Must be positive" belongs to enrollment, where the amount
      // is being entered on purpose, not to a PATCH that carries it along.
      //
      // Negative and non-numeric are still refused, and paid <= final below is
      // untouched: that is the rule that actually protects the ledger.
      finalAmount = Number(req.body.final_amount);
      if (!Number.isFinite(finalAmount) || finalAmount < 0) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Final Selling Price cannot be negative.' } });
      }
    }
    if (wantsPaidAmount) {
      paidAmount = Number(req.body.paid_amount);
      if (!Number.isFinite(paidAmount) || paidAmount < 0) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Amount Paid cannot be negative.' } });
      }
    }
    const effectiveFinal = finalAmount ?? (Number(existing.final_amount) || 0);
    const effectivePaid  = paidAmount  ?? (Number(existing.paid_amount)  || 0);
    if (effectivePaid > effectiveFinal) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Amount Paid cannot exceed Final Selling Price.' } });
    }
  }

  const sets = [];
  const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      params.push(req.body[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  let finalAmountParamIdx = null;
  let paidAmountParamIdx = null;
  if (wantsFinalAmount) { params.push(finalAmount); finalAmountParamIdx = params.length; sets.push(`final_amount = $${finalAmountParamIdx}`); }
  if (wantsPaidAmount)  { params.push(paidAmount);  paidAmountParamIdx = params.length;  sets.push(`paid_amount = $${paidAmountParamIdx}`); }
  if (wantsFinalAmount || wantsPaidAmount) {
    // Recompute from whichever of the two just landed in params, falling
    // back to the column's current value for the one that didn't change.
    // The two operands need an explicit ::numeric cast: when BOTH final_amount
    // and paid_amount are being set in the same request (the normal case for
    // a brand-new enrollment), both sides of the subtraction are bare
    // parameter placeholders with nothing else to anchor their type, and
    // Postgres can't resolve "-" between two "unknown"-typed params —
    // it throws "operator is not unique: unknown - unknown" (a 500, not a
    // validation error). A column reference (the single-param fallback path)
    // happens to carry its own type and never hit this.
    sets.push(
      `balance_amount = GREATEST(` +
        `${finalAmountParamIdx ? `$${finalAmountParamIdx}::numeric` : 'final_amount'} - ` +
        `${paidAmountParamIdx ? `$${paidAmountParamIdx}::numeric` : 'paid_amount'}, 0)`
    );
  }
  // Defense in depth: PATCH only ever touches status when a caller explicitly
  // sends it, unlike POST /clients (which auto-promotes 'pending' to
  // 'active' once a package is attached). If this request IS establishing
  // enrollment — an end date, a real duration, or a real final amount — but
  // forgot to say so, promote it here too. Without this, a caller that omits
  // status (as the enroll page did) silently leaves a fully-paid,
  // fully-scheduled client stuck showing "Not Enrolled" forever.
  const looksEnrolled =
    req.body.pt_end_date != null ||
    Number(req.body.duration_months) > 0 ||
    (wantsFinalAmount && finalAmount > 0);
  if (req.body.status === undefined && looksEnrolled) sets.push(`status = 'active'`);

  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS', message: 'No fields to update' } });
  sets.push('updated_at = NOW()');

  const updOrg = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE pt_clients SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL${updOrg} RETURNING *`,
    params
  );
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  // Term history: unlike /clients/:id/renew, this endpoint (the actual
  // enrollment action — see the enroll page) never wrote a row into
  // pt_client_subscriptions, so a client's first term never appeared on
  // the PT Subscription History page even though they were fully active —
  // only later renewals showed up there. Log the initial term the first
  // time a client crosses into "enrolled", i.e. only when they don't
  // already have subscription history (so later plain-field edits through
  // this same endpoint, e.g. the client-edit page, never add duplicates).
  if (looksEnrolled) {
    const { rows: existingTerms } = await pool.query(
      'SELECT 1 FROM pt_client_subscriptions WHERE client_id = $1 LIMIT 1', [req.params.id]
    );
    if (existingTerms.length === 0) {
      await pool.query(`
        INSERT INTO pt_client_subscriptions
          (client_id, plan_name, start_date, end_date, duration_months,
           selling_price, amount_paid, balance_amount, trainer_name, status, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','enrollment')
        ON CONFLICT DO NOTHING
      `, [
        req.params.id, rows[0].package_type,
        rows[0].pt_start_date, rows[0].pt_end_date, rows[0].duration_months,
        rows[0].final_amount, rows[0].paid_amount, rows[0].balance_amount,
        rows[0].trainer_name,
      ]);
    }
  }

  // Ledger: an increase in paid_amount is collected money — record it in
  // pt_payments so revenue reports (which sum the payment ledgers, not
  // pt_clients.paid_amount) actually see it. Without this, money collected
  // at enrolment never appeared in any revenue figure.
  if (wantsPaidAmount && previousPaid !== null && paidAmount > previousPaid) {
    const delta = paidAmount - previousPaid;
    let ledgerTrainerId = null;
    let incentiveRate = 0;
    if (rows[0].trainer_id) {
      const { rows: tr } = await pool.query(
        'SELECT id, incentive_rate FROM trainers WHERE id=$1', [rows[0].trainer_id]
      );
      if (tr[0]) { ledgerTrainerId = tr[0].id; incentiveRate = tr[0].incentive_rate ?? 0.5; }
    }
    await pool.query(
      `INSERT INTO pt_payments (client_id, trainer_id, amount, incentive_amt, payment_method, date, notes, organization_id)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7)`,
      [req.params.id, ledgerTrainerId, delta, Math.round(delta * incentiveRate),
       String(req.body.payment_method || 'CASH').toUpperCase(), 'Collected via client profile / enrolment',
       orgIdOf(req)]
    );
  }

  // The resulting state only, not a before/after diff — this endpoint is a
  // hot path (every client-profile save goes through it) and an extra SELECT
  // purely to capture prior state on every edit isn't worth the round trip
  // this record already gets from the UPDATE ... RETURNING above.
  await logActivity(req, 'client.update', 'pt_client', rows[0].id, rows[0]);
  res.json({ data: rows[0] });
}));

// ─── Client photo upload ────────────────────────────────────
router.post('/clients/:id/photo', auth, wrap(async (req, res) => {
  const { photo } = req.body;
  if (!photo) return res.status(400).json({ error: { code: 'NO_PHOTO', message: 'No photo data provided' } });
  const params = [photo, req.params.id];
  const orgClause = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE pt_clients SET photo_url = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL${orgClause} RETURNING id`,
    params
  );
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  res.json({ data: rows[0] });
}));

// ─── Save client notes ──────────────────────────────────────
router.put('/clients/:id/notes', auth, wrap(async (req, res) => {
  const { notes } = req.body;
  if (notes === undefined) return res.status(400).json({ error: { code: 'NO_NOTES', message: 'Missing notes' } });
  const params = [notes, req.params.id];
  const orgClause = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE pt_clients SET notes = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL${orgClause} RETURNING id, notes`,
    params
  );
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  res.json({ data: rows[0] });
}));

// ─── Delete PT client (soft-delete) ─────────────────────────
router.delete('/clients/:id', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const params = [req.params.id];
  const orgClause = orgWhere(req, params);
  const { rows } = await pool.query(`
    UPDATE pt_clients
    SET deleted_at = NOW(), updated_at = NOW(), status = 'inactive'
    WHERE id = $1 AND deleted_at IS NULL${orgClause}
    RETURNING id
  `, params);
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  await logActivity(req, 'client.delete', 'pt_client', rows[0].id);
  res.json({ message: 'Client deleted' });
}));

// ─── Client communication history ───────────────────────────
router.get('/clients/:id/communication', auth, wrap(async (req, res) => {
  if (!await clientInOrg(req, req.params.id))
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const { rows } = await pool.query(`
    SELECT cl.*, c.name AS client_name
    FROM communication_logs cl
    LEFT JOIN pt_clients c ON c.id = cl.recipient_id
    WHERE cl.recipient_type = 'client' AND cl.recipient_id = $1
    ORDER BY cl.created_at DESC
    LIMIT 100
  `, [req.params.id]);
  res.json({ data: rows, total: rows.length });
}));

// ─── Subscription history ───────────────────────────────────
router.get('/clients/:id/subscriptions', auth, wrap(async (req, res) => {
  if (!await clientInOrg(req, req.params.id))
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const { rows } = await pool.query(`
    SELECT id, plan_name, start_date, end_date, duration_months,
           selling_price, amount_paid, balance_amount, trainer_name, status, source, created_at
    FROM pt_client_subscriptions
    WHERE client_id = $1
    ORDER BY start_date ASC NULLS LAST, created_at ASC
  `, [req.params.id]);
  res.json({ data: rows, total: rows.length });
}));

// ─── Leads (pre-enrollment pipeline) ─────────────────────────
const LEAD_STATUSES = ['new', 'contacted', 'trial_scheduled', 'converted', 'lost'];

const ptLeadCreateSchema = {
  body: z.object({
    name: z.string().min(1).max(255),
    mobile: z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian mobile number').optional().nullable(),
    email: z.string().email().optional().nullable(),
    source: z.string().max(50).optional().nullable(),
    interested_package: z.string().max(255).optional().nullable(),
    trainer_id: z.string().optional().nullable(),
    trainer_name: z.string().max(255).optional().nullable(),
    follow_up_date: z.string().optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  }),
};

router.get('/leads', auth, wrap(async (req, res) => {
  const params = [];
  const orgClause = orgWhere(req, params);
  let statusClause = '';
  if (req.query.status && LEAD_STATUSES.includes(String(req.query.status))) {
    params.push(req.query.status);
    statusClause = ` AND status = $${params.length}`;
  }
  let searchClause = '';
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    searchClause = ` AND (name ILIKE $${params.length} OR mobile ILIKE $${params.length} OR email ILIKE $${params.length})`;
  }
  const { rows } = await pool.query(`
    SELECT * FROM pt_leads
    WHERE 1=1${orgClause}${statusClause}${searchClause}
    ORDER BY created_at DESC
  `, params);
  res.json({ data: rows, total: rows.length });
}));

router.post('/leads', auth, requireRole('admin','manager','trainer'), validate(ptLeadCreateSchema), wrap(async (req, res) => {
  const { name, mobile, email, source, interested_package, trainer_id, trainer_name, follow_up_date, notes } = req.body;
  const { rows } = await pool.query(`
    INSERT INTO pt_leads
      (organization_id, name, mobile, email, source, interested_package, trainer_id, trainer_name, follow_up_date, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
  `, [
    orgIdOf(req), name, mobile || null, email || null, source || 'other',
    interested_package || null, trainer_id || null, trainer_name || null,
    follow_up_date || null, notes || null,
  ]);
  res.status(201).json({ data: rows[0] });
}));

router.patch('/leads/:id', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  if (req.body.status !== undefined && !LEAD_STATUSES.includes(req.body.status)) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: `status must be one of: ${LEAD_STATUSES.join(', ')}` } });
  }
  const allowed = ['name','mobile','email','source','status','interested_package','trainer_id','trainer_name','follow_up_date','notes'];
  const sets = [];
  const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      params.push(req.body[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS', message: 'No fields to update' } });
  sets.push('updated_at = NOW()');
  const orgClause = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE pt_leads SET ${sets.join(', ')} WHERE id = $1${orgClause} RETURNING *`,
    params
  );
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
  res.json({ data: rows[0] });
}));

router.delete('/leads/:id', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const params = [req.params.id];
  const orgClause = orgWhere(req, params);
  const { rowCount } = await pool.query(`DELETE FROM pt_leads WHERE id = $1${orgClause}`, params);
  if (rowCount === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
  res.json({ message: 'Lead deleted' });
}));

// Converts a lead into a bare (pending) PT client — mirrors the bare-client
// branch of POST /clients — then hands off to the existing Enroll flow for
// package/payment details, rather than duplicating that form here.
router.post('/leads/:id/convert', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const params = [req.params.id];
  const orgClause = orgWhere(req, params);
  const { rows: leadRows } = await pool.query(`SELECT * FROM pt_leads WHERE id = $1${orgClause}`, params);
  if (leadRows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
  const lead = leadRows[0];
  if (lead.status === 'converted' && lead.converted_client_id) {
    return res.status(409).json({
      error: { code: 'ALREADY_CONVERTED', message: 'This lead has already been converted.' },
      client_id: lead.converted_client_id,
    });
  }

  // Same plan-seat check as POST /clients (bare-client branch) — converting a
  // lead creates a new pt_clients row too, so it must respect the same SaaS
  // client-limit gate rather than offering a side door around it.
  const { limit, count, atLimit } = await subscription.clientLimitStatus(orgIdOf(req));
  if (atLimit) {
    return res.status(403).json({
      error: {
        code: 'PLAN_LIMIT_REACHED',
        message: `You've reached your plan's limit of ${limit} clients. Upgrade your plan to add more.`,
        limit, count,
      },
    });
  }

  const { rows: clientRows } = await pool.query(`
    INSERT INTO pt_clients
      (name, mobile, email, status, joining_date, trainer_id, trainer_name, organization_id)
    VALUES ($1,$2,$3,'pending',CURRENT_DATE,$4,$5,$6)
    RETURNING id
  `, [lead.name, lead.mobile, lead.email, lead.trainer_id, lead.trainer_name, orgIdOf(req)]);
  const newClientId = clientRows[0].id;

  await pool.query(
    `UPDATE pt_leads SET status = 'converted', converted_client_id = $2, converted_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [req.params.id, newClientId]
  );

  res.status(201).json({ data: { client_id: newClientId } });
}));

// ─── Balance sheet ──────────────────────────────────────────
router.get('/balance-sheet', auth, wrap(async (req, res) => {
  const trainerId = req.user.role === 'trainer' ? req.user.trainer_id : req.query.trainer_id;
  const rows = await svc.getBalanceSheet(trainerId, tenantScope(req));
  res.json({ data: rows, total: rows.length, total_outstanding: rows.reduce((s, r) => s + Number(r.balance_amount), 0) });
}));

// ─── Commissions ────────────────────────────────────────────
router.get('/commissions', auth, wrap(async (req, res) => {
  const trainerId = req.user.role === 'trainer' ? req.user.trainer_id : req.query.trainer_id;
  const rows = await svc.getCommissionHistory(trainerId);
  res.json({ data: rows });
}));

router.post('/commissions/calculate', auth, adminOnly, wrap(async (req, res) => {
  const month = req.body.month || new Date().toISOString().slice(0, 7);
  const result = await svc.calculateMonthlyCommissions(month);
  res.json({ data: result });
}));

// Update trainer commission rate
//
// Had no tenant filter at all — same class of bug the GET /trainers comment
// above documents ("one studio's commission terms readable by its
// competitors"), except this one is a write: any admin could change any
// trainer's commission rate platform-wide by id alone. Fixed with the same
// orgWhere() every sibling write in this file already uses.
router.put('/commissions/:trainerId', auth, adminOnly, wrap(async (req, res) => {
  const { commission_pct } = req.body;
  if (commission_pct === undefined) return res.json({ data: { success: true } });

  const rate = Number(commission_pct);
  const beforeParams = [req.params.trainerId];
  const beforeOrg = orgWhere(req, beforeParams);
  const { rows: before } = await pool.query(
    `SELECT id, name, incentive_rate FROM pt_trainers WHERE id = $1${beforeOrg}`, beforeParams
  );
  if (before.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Trainer not found' } });

  const updParams = [rate, req.params.trainerId];
  const updOrg = orgWhere(req, updParams);
  await pool.query(
    `UPDATE pt_trainers SET incentive_rate = $1, updated_at = NOW() WHERE id = $2${updOrg}`,
    updParams
  );

  await logActivity(
    req, 'trainer.commission_update', 'pt_trainer', req.params.trainerId,
    { incentive_rate: rate }, { incentive_rate: before[0].incentive_rate }
  );
  res.json({ data: { success: true } });
}));

// ─── Payouts ────────────────────────────────────────────────
router.get('/payouts', auth, wrap(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const rows = await svc.getTrainerPayouts(month);
  res.json({ data: rows, month });
}));

router.post('/payouts', auth, adminOnly, wrap(async (req, res) => {
  const { trainer_id, month, deductions } = req.body;
  const payout = await svc.createPayout(trainer_id, month, deductions || 0, req.user.id);
  res.status(201).json({ data: payout });
}));

// Mark all pending payouts for a month as paid (MUST be before /:id/approve)
router.post('/payouts/mark-all-paid', auth, adminOnly, wrap(async (req, res) => {
  const month = req.body.month || new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01`;
  const { rowCount } = await pool.query(
    `UPDATE pt_payouts SET status = 'paid', paid_at = NOW(), updated_at = NOW()
     WHERE month = $1 AND status != 'paid'`,
    [monthStart]
  );
  res.json({ data: { updated: rowCount } });
}));

// Update payout status/amount for a specific trainer
router.put('/payouts/:trainerId', auth, adminOnly, wrap(async (req, res) => {
  const { payout_status, paid_amount } = req.body;
  const month = req.query.month || req.body.month || new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01`;
  const setParts = [];
  const vals = [];
  let idx = 1;
  if (payout_status !== undefined) {
    setParts.push(`status = $${idx++}`);
    vals.push(payout_status);
    if (payout_status === 'paid') setParts.push(`paid_at = NOW()`);
  }
  if (paid_amount !== undefined) { setParts.push(`net_amount = $${idx++}`); vals.push(Number(paid_amount)); }
  if (setParts.length) {
    vals.push(req.params.trainerId, monthStart);
    await pool.query(
      `UPDATE pt_payouts SET ${setParts.join(', ')}, updated_at = NOW() WHERE trainer_id = $${idx} AND month = $${idx + 1}`,
      vals
    );
  }
  res.json({ data: { success: true } });
}));

router.post('/payouts/:id/approve', auth, adminOnly, wrap(async (req, res) => {
  const { payment_method, payment_ref } = req.body;
  const payout = await svc.markPayoutPaid(req.params.id, payment_method, payment_ref, req.user.id);
  res.json({ data: payout });
}));

// ─── Revenue report ─────────────────────────────────────────
router.get('/revenue', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      DATE_TRUNC('month', date)::DATE AS month,
      COUNT(*)::INT AS transactions,
      COALESCE(SUM(amount), 0) AS revenue,
      COALESCE(SUM(incentive_amt), 0) AS incentives,
      COUNT(*) FILTER (WHERE incentive_amt > 0)::INT AS incentive_count
    FROM pt_payments
    WHERE deleted_at IS NULL
      AND date >= DATE_TRUNC('year', CURRENT_DATE)
    GROUP BY DATE_TRUNC('month', date)
    ORDER BY month DESC
  `);
  res.json({ data: rows });
}));

// ─── Trainer performance ────────────────────────────────────
router.get('/trainer-performance', auth, adminOrManager, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      t.id, t.name, t.incentive_rate,
      COUNT(c.id) FILTER (WHERE c.status = 'active')::INT AS active_clients,
      COALESCE(SUM(c.monthly_pt_amount) FILTER (WHERE c.status = 'active'), 0) AS monthly_pt_revenue,
      COALESCE(SUM(c.trainer_commission) FILTER (WHERE c.status = 'active'), 0) AS monthly_commission,
      COALESCE(SUM(p.amount) FILTER (WHERE p.deleted_at IS NULL), 0) AS total_payment_revenue,
      COALESCE(SUM(p.incentive_amt) FILTER (WHERE p.deleted_at IS NULL), 0) AS total_incentives
    FROM pt_trainers t
    LEFT JOIN pt_clients c ON c.trainer_id = t.id AND c.deleted_at IS NULL AND c.pt_start_date IS NOT NULL
    LEFT JOIN pt_payments p ON p.trainer_id = t.id AND p.deleted_at IS NULL
    WHERE t.deleted_at IS NULL AND t.status = 'active'
    GROUP BY t.id, t.name, t.incentive_rate
    ORDER BY monthly_pt_revenue DESC
  `);
  res.json({ data: rows });
}));

// ─── Sessions ───────────────────────────────────────────────
router.get('/sessions', auth, wrap(async (req, res) => {
  const { trainer_id, date } = req.query;
  const where = ['s.deleted_at IS NULL'];
  const params = [];
  const scope = tenantScope(req);
  if (scope.applyFilter) { params.push(scope.orgId); where.push(`s.organization_id = $${params.length}`); }
  if (trainer_id) { params.push(trainer_id); where.push(`s.trainer_id = $${params.length}`); }
  if (date) { params.push(date); where.push(`s.session_date = $${params.length}`); }
  const { rows } = await pool.query(`
    SELECT s.*, c.name AS client_name
    FROM pt_sessions s
    LEFT JOIN pt_clients c ON c.id = s.client_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.session_date DESC, s.start_time
  `, params);
  res.json({ data: rows });
}));

// Every trainer profile that IS the caller, as a list of pt_sessions.trainer_id
// values to match on.
//
// Two things make a single id wrong here.
//
// First, `users.trainer_id` is only ever populated by the studio-approval path
// (super-admin/registrations.js, super-admin/organizations.js) — those create a
// `trainers` row and link it in the same transaction. An account created any
// other way (the /auth/register route leaves it null unless a trainer_id is
// passed, and every pre-approval-flow studio predates it) has no link at all,
// even when that person is the studio's only trainer and has a full diary.
// Keying solely off the column reported "not linked" to the studio owner and
// told them to ask an admin — which they are.
//
// Second, `pt_sessions.trainer_id` has had NO foreign key since migration
// 018 dropped pt_sessions_trainer_id_fkey, and the Book Session picker is fed
// by GET /trainers, a UNION of `trainers` and `pt_trainers`. So a booked
// session's trainer_id can be an id from EITHER table, and the same human
// routinely exists in both. Matching one id misses the other's sessions.
//
// Hence: the explicit link, plus an email match in both tables, all within the
// caller's own organisation. Email is the join the two trainer tables already
// share — 018 seeded pt_trainers FROM trainers carrying it across.
//
// The org filter mirrors GET /trainers exactly, including excluding NULL
// organization_id rather than treating it as shared: an unattributable trainer
// matched into someone's schedule is the same leak that route was fixed for.
// This is defence in depth only — the session query below is independently
// org-scoped, which is the boundary that actually holds.
async function resolveMyTrainerIds(req) {
  const ids = new Set();
  if (req.user.trainer_id) ids.add(req.user.trainer_id);

  const email = String(req.user.email || '').trim().toLowerCase();
  if (email) {
    const scope = tenantScope(req);
    const params = [email];
    let orgFilter = '';
    if (scope.applyFilter) {
      params.push(scope.orgId);
      orgFilter = `AND organization_id = $${params.length}`;
    }
    const { rows } = await pool.query(`
      SELECT id FROM trainers
       WHERE deleted_at IS NULL AND LOWER(email) = $1 ${orgFilter}
      UNION
      SELECT id FROM pt_trainers
       WHERE deleted_at IS NULL AND LOWER(email) = $1 ${orgFilter}
    `, params);
    for (const r of rows) ids.add(r.id);
  }

  return [...ids];
}

// ─── My Schedule — the caller's OWN sessions as a trainer ────
// Distinct from GET /sessions, which is the studio-wide list and only
// filters by trainer when the caller passes an explicit trainer_id.
// Here the trainer is always the authenticated user, so one staff member
// can never read another's schedule by editing a query param.
//
// `trainer_linked: false` means this user account isn't attached to a
// trainer profile (e.g. a front-desk admin who doesn't train). That is a
// legitimate state, not an error — it returns no sessions and lets the
// page say why, rather than showing a bare empty list that looks broken.
router.get('/sessions/my', auth, wrap(async (req, res) => {
  const trainerIds = await resolveMyTrainerIds(req);
  if (!trainerIds.length) return res.json({ data: [], total: 0, trainer_linked: false });

  // = ANY($1) rather than an IN-list built by string concatenation: one bound
  // parameter regardless of how many profiles resolved.
  const params = [trainerIds];
  const where = ['s.deleted_at IS NULL', `s.trainer_id = ANY($1)`];
  const scope = tenantScope(req);
  if (scope.applyFilter) { params.push(scope.orgId); where.push(`s.organization_id = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); where.push(`s.session_date >= $${params.length}`); }
  if (req.query.to)   { params.push(req.query.to);   where.push(`s.session_date <= $${params.length}`); }

  const { rows } = await pool.query(`
    SELECT s.*, c.name AS client_name, c.mobile AS client_mobile
    FROM pt_sessions s
    LEFT JOIN pt_clients c ON c.id = s.client_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.session_date ASC, s.start_time ASC
  `, params);
  res.json({ data: rows, total: rows.length, trainer_linked: true });
}));

// Adds `minutes` to a 'HH:MM' or 'HH:MM:SS' time string, returning 'HH:MM:SS'.
// Used to derive end_time from start_time + duration server-side rather
// than trusting a client-computed value (or leaving it null, which is
// what happened before this fix).
function addMinutesToTime(timeStr, minutes) {
  const [h, m, s] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor((total % 1440) / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(s || 0).padStart(2, '0')}`;
}

// Adds `days` to a 'YYYY-MM-DD' date string, returning 'YYYY-MM-DD'.
function addDaysToDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

router.post('/sessions', auth, wrap(async (req, res) => {
  const { client_id, client, trainer_id, title, date, start_time, end_time, notes,
    duration_minutes, session_type, recurring } = req.body;
  let cid = client_id;
  if (!cid && client) {
    const nameParams = [client];
    const nameOrg = orgWhere(req, nameParams);
    const { rows } = await pool.query(`SELECT id FROM pt_clients WHERE name = $1 AND deleted_at IS NULL${nameOrg} LIMIT 1`, nameParams);
    if (rows.length > 0) cid = rows[0].id;
  }
  // When client_id is supplied directly, verify it belongs to the caller's org
  // so a session can't be booked against another studio's client.
  if (cid && !await clientInOrg(req, cid))
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const duration = parseInt(duration_minutes, 10) || 60;
  const computedEndTime = end_time || (start_time ? addMinutesToTime(start_time, duration) : null);

  // Recurring: book this session plus 3 more at the same weekly slot,
  // sharing one recurrence_id so they can be identified as a group later.
  const occurrences = recurring ? 4 : 1;
  const recurrenceId = recurring ? randomUUID() : null;
  const created = [];
  for (let i = 0; i < occurrences; i++) {
    const occDate = i === 0 ? date : addDaysToDate(date, 7 * i);
    const { rows } = await pool.query(
      `INSERT INTO pt_sessions (client_id, trainer_id, title, session_date, start_time, end_time,
         notes, created_by, duration_minutes, session_type, recurrence_id, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [cid, trainer_id, title || 'PT Session', occDate, start_time, computedEndTime, notes, req.user.id,
       duration, session_type || '1-on-1', recurrenceId, orgIdOf(req)]
    );
    created.push(rows[0]);
  }
  res.status(201).json({ data: occurrences === 1 ? created[0] : created });
}));

// PATCH /sessions/:id
router.patch('/sessions/:id', auth, wrap(async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const scope = tenantScope(req);
  const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: existingRows } = await pool.query(
    `SELECT start_time, duration_minutes FROM pt_sessions WHERE id = $1 AND deleted_at IS NULL${guard}`,
    scope.applyFilter ? [id, scope.orgId] : [id]
  );
  if (!existingRows[0]) return res.status(404).json({ error: 'Session not found' });

  const allowed = ['status', 'notes', 'session_date', 'start_time', 'duration_minutes', 'session_type'];
  const sets = [];
  const params = [id];
  for (const key of allowed) {
    if (b[key] !== undefined) { params.push(b[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

  if (b.start_time !== undefined || b.duration_minutes !== undefined) {
    const mergedStart = b.start_time ?? existingRows[0].start_time;
    const mergedDuration = b.duration_minutes ?? existingRows[0].duration_minutes;
    if (mergedStart) {
      params.push(addMinutesToTime(mergedStart, mergedDuration));
      sets.push(`end_time = $${params.length}`);
    }
  }
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(
    `UPDATE pt_sessions SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    params
  );
  res.json({ data: rows[0] });
}));

// ─── Payments ───────────────────────────────────────────────
router.get('/payments', auth, wrap(async (req, res) => {
  const { client_id, trainer_id } = req.query;
  const where = ['p.deleted_at IS NULL'];
  const params = [];
  if (client_id) { params.push(client_id); where.push(`p.client_id = $${params.length}`); }
  if (trainer_id) { params.push(trainer_id); where.push(`p.trainer_id = $${params.length}`); }
  const pOrg = orgWhere(req, params, 'p.organization_id');
  if (pOrg) where.push(pOrg.replace(/^ AND /, ''));
  const { rows } = await pool.query(`
    SELECT p.*, c.name AS client_name, COALESCE(t.name, ptt.name) AS trainer_name
    FROM pt_payments p
    LEFT JOIN pt_clients c ON c.id = p.client_id
    LEFT JOIN trainers t ON t.id = p.trainer_id
    LEFT JOIN pt_trainers ptt ON ptt.id = p.trainer_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.date DESC
  `, params);
  res.json({ data: rows });
}));

router.post('/payments', auth, wrap(async (req, res) => {
  const { client_id, trainer_id, amount, incentive_amt, payment_method, payment_ref, date, notes } = req.body;
  const numAmount = Number(amount) || 0;

  // A payment can only be recorded against a client in the caller's own org.
  if (client_id && !await clientInOrg(req, client_id))
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  // Validate trainer_id FK (pt_payments.trainer_id references trainers after
  // migration 072) — fall back to null if the trainer no longer exists.
  let resolvedTrainerId = trainer_id || null;
  if (resolvedTrainerId) {
    const { rows: tr } = await pool.query(
      'SELECT id FROM trainers WHERE id = $1 AND deleted_at IS NULL', [resolvedTrainerId]
    );
    if (!tr.length) {
      // Also try looking up by the client's current trainer
      const { rows: cl } = await pool.query(
        'SELECT trainer_id FROM pt_clients WHERE id = $1 AND deleted_at IS NULL', [client_id]
      );
      const fallback = cl[0]?.trainer_id;
      if (fallback && fallback !== resolvedTrainerId) {
        const { rows: tr2 } = await pool.query(
          'SELECT id FROM trainers WHERE id = $1 AND deleted_at IS NULL', [fallback]
        );
        resolvedTrainerId = tr2.length ? fallback : null;
      } else {
        resolvedTrainerId = null;
      }
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO pt_payments (client_id, trainer_id, amount, incentive_amt, payment_method, payment_ref, date, notes, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [client_id, resolvedTrainerId, numAmount, incentive_amt ?? 0, payment_method, payment_ref, date || new Date(), notes,
     orgIdOf(req)]
  );
  // update client paid_amount and balance_amount
  await pool.query(
    `UPDATE pt_clients SET
       paid_amount = paid_amount + $1,
       balance_amount = GREATEST(balance_amount - $1, 0),
       updated_at = NOW()
     WHERE id = $2 AND deleted_at IS NULL`,
    [numAmount, client_id]
  );
  res.status(201).json({ data: rows[0] });
}));

// ─── Execute Duplicate Merge ─────────────────────────────────
router.post('/clients/merge-duplicates', auth, adminOnly, wrap(async (req, res) => {
  // Tenant boundary: duplicate detection + merge must stay within the caller's
  // own org, or an admin could merge (and thereby absorb/destroy) another
  // studio's clients. A platform super admin operating platform-wide gets NULL
  // → the null-safe predicate matches all orgs (they should use the
  // org-switcher to target one studio before merging).
  const scope = tenantScope(req);
  const oParam = scope.applyFilter ? scope.orgId : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Ensure backup table exists and snapshot affected records
    await client.query(`
      CREATE TABLE IF NOT EXISTS pt_clients_merge_backup (
        LIKE pt_clients INCLUDING ALL,
        backed_up_at TIMESTAMPTZ DEFAULT NOW(),
        merge_run TEXT
      )
    `);
    const mergeRun = new Date().toISOString();
    await client.query(`
      INSERT INTO pt_clients_merge_backup
        SELECT *, NOW(), $1 FROM pt_clients
        WHERE deleted_at IS NULL
          AND ($2::uuid IS NULL OR organization_id = $2)
          AND TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))) IN (
            SELECT TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g')))
            FROM pt_clients WHERE deleted_at IS NULL
              AND ($2::uuid IS NULL OR organization_id = $2)
            GROUP BY TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g')))
            HAVING COUNT(*) > 1
          )
    `, [mergeRun, oParam]);

    // 2. Ensure merge log table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS pt_clients_merge_log (
        id            SERIAL PRIMARY KEY,
        run_id        TEXT,
        run_at        TIMESTAMPTZ DEFAULT NOW(),
        master_id     TEXT,
        merged_ids    TEXT[],
        normalized_name TEXT,
        record_count  INT,
        subs_merged   INT,
        total_final   NUMERIC,
        total_paid    NUMERIC,
        balance       NUMERIC
      )
    `);

    // 3. Fetch all duplicate groups in one shot
    const { rows: groups } = await client.query(`
      SELECT
        TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))) AS norm,
        ARRAY_AGG(id ORDER BY created_at ASC) AS all_ids,
        COUNT(*)::int AS cnt,
        SUM(final_amount)  AS total_final,
        SUM(paid_amount)   AS total_paid,
        SUM(base_amount)   AS total_base,
        GREATEST(0, SUM(final_amount) - SUM(paid_amount)) AS balance
      FROM pt_clients WHERE deleted_at IS NULL
        AND ($1::uuid IS NULL OR organization_id = $1)
      GROUP BY TRIM(LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g')))
      HAVING COUNT(*) > 1
    `, [oParam]);

    const results = [];

    // Tables that may hold references to pt_clients.id via client_id
    const refTables = [
      'pt_payments','pt_sessions','pt_commissions',
      'pt_assessments','pt_goals','weekly_checkins',
      'workout_assignments','diet_assignments','session_balance',
      'strength_logs','progress_photos','weight_logs',
      'pt_os_measurements','pt_os_sessions','pt_os_payments',
      'pt_os_assignments','pt_os_ai_insights','pt_os_coaching_events',
      'trial_sessions','churn_risk_log','client_notifications','follow_ups',
      'client_documents','client_fitness_profiles','nutrition_logs',
      'face_checkin_logs','face_descriptors',
    ];

    for (const grp of groups) {
      const masterId = grp.all_ids[0];
      const dupIds   = grp.all_ids.slice(1);

      // Update master: aggregate financials + latest subscription info
      await client.query(`
        UPDATE pt_clients SET
          final_amount    = $1,
          paid_amount     = $2,
          base_amount     = $3,
          balance_amount  = GREATEST(0, $1 - $2),
          pt_start_date   = (SELECT pt_start_date  FROM pt_clients WHERE id = ANY($4) AND pt_start_date IS NOT NULL ORDER BY pt_start_date DESC NULLS LAST LIMIT 1),
          pt_end_date     = (SELECT pt_end_date    FROM pt_clients WHERE id = ANY($4) AND pt_start_date IS NOT NULL ORDER BY pt_start_date DESC NULLS LAST LIMIT 1),
          duration_months = (SELECT duration_months FROM pt_clients WHERE id = ANY($4) AND pt_start_date IS NOT NULL ORDER BY pt_start_date DESC NULLS LAST LIMIT 1),
          package_type    = (SELECT package_type   FROM pt_clients WHERE id = ANY($4) AND package_type IS NOT NULL ORDER BY COALESCE(pt_start_date,'1970-01-01') DESC LIMIT 1),
          monthly_pt_amount = (SELECT monthly_pt_amount FROM pt_clients WHERE id = ANY($4) AND pt_start_date IS NOT NULL ORDER BY pt_start_date DESC NULLS LAST LIMIT 1),
          trainer_name    = (SELECT trainer_name   FROM pt_clients WHERE id = ANY($4) AND trainer_name IS NOT NULL ORDER BY COALESCE(pt_start_date,'1970-01-01') DESC LIMIT 1),
          mobile          = COALESCE((SELECT mobile  FROM pt_clients WHERE id = ANY($4) AND mobile IS NOT NULL AND mobile != '' ORDER BY updated_at DESC LIMIT 1), mobile),
          email           = COALESCE((SELECT email   FROM pt_clients WHERE id = ANY($4) AND email  IS NOT NULL ORDER BY updated_at DESC LIMIT 1), email),
          address         = COALESCE((SELECT address FROM pt_clients WHERE id = ANY($4) AND address IS NOT NULL ORDER BY updated_at DESC LIMIT 1), address),
          notes           = COALESCE((SELECT notes   FROM pt_clients WHERE id = ANY($4) AND notes  IS NOT NULL ORDER BY updated_at DESC LIMIT 1), notes),
          joining_date    = (SELECT MIN(joining_date) FROM pt_clients WHERE id = ANY($4) AND joining_date IS NOT NULL),
          updated_at      = NOW()
        WHERE id = $5 AND deleted_at IS NULL
      `, [grp.total_final, grp.total_paid, grp.total_base, grp.all_ids, masterId]);

      // Re-point all related records to master
      for (const tbl of refTables) {
        await client.query(
          `UPDATE ${tbl} SET client_id = $1 WHERE client_id = ANY($2)`,
          [masterId, dupIds]
        );
      }

      // Soft-delete duplicates
      await client.query(
        `UPDATE pt_clients SET deleted_at = NOW(), updated_at = NOW() WHERE id = ANY($1)`,
        [dupIds]
      );

      // Log this merge
      await client.query(`
        INSERT INTO pt_clients_merge_log
          (run_id, master_id, merged_ids, normalized_name, record_count, subs_merged, total_final, total_paid, balance)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [mergeRun, masterId, dupIds, grp.norm, grp.cnt, grp.cnt - 1,
          grp.total_final, grp.total_paid, grp.balance]);

      results.push({
        name: grp.norm,
        master_id: masterId,
        merged_count: dupIds.length,
        total_final: Number(grp.total_final),
        total_paid: Number(grp.total_paid),
        balance: Number(grp.balance),
      });
    }

    await client.query('COMMIT');

    logger.info(`[merge-duplicates] run_id=${mergeRun} groups=${results.length} records_removed=${results.reduce((s,r)=>s+r.merged_count,0)}`);
    res.json({
      success: true,
      run_id: mergeRun,
      merged_groups: results.length,
      records_removed: results.reduce((s, r) => s + r.merged_count, 0),
      results,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[merge-duplicates] error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}));

// ─── Operations Summary (today's sessions, renewals, dues) ──────────────────
router.get('/dashboard/ops', auth, wrap(async (req, res) => {
  const data = await svc.getOpsSummary(tenantScope(req));
  res.json({ data });
}));

// GET /clients/:id/training-brief
//
// Everything needed to write this client a programme, in one payload.
//
// The information already exists — PAR-Q, fitness testing, posture, mobility,
// lifestyle, goals — spread across six screens a trainer would have to open
// one at a time before designing anything. Nobody does that, so programmes get
// written from memory and the assessment data goes unread.
//
// Seven reads in parallel rather than seven round trips from the client: this
// is opened at the moment somebody has decided to build a plan, and a spinner
// per section is a reason to skip the whole thing.
//
// Each source takes the LATEST row. A brief is a picture of the client now,
// not a history — the history lives on its own screens.
router.get('/clients/:id/training-brief', auth, wrap(async (req, res) => {
  const clientId = req.params.id;
  const params = [clientId];
  const orgClause = orgWhere(req, params, 'c.organization_id');

  const { rows: clientRows } = await pool.query(
    `SELECT c.id, c.name, c.gender, c.dob, c.goal, c.injuries, c.notes, c.organization_id
       FROM pt_clients c WHERE c.id = $1 AND c.deleted_at IS NULL ${orgClause}`,
    params,
  );
  const client = clientRows[0];
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const one = (sql) => pool.query(sql, [clientId]).then((r) => r.rows[0] ?? null);

  const [parq, assessment, posture, mobility, lifestyle, goal, assignment, sessions] = await Promise.all([
    one(`SELECT * FROM pt_parq_forms WHERE client_id = $1 AND deleted_at IS NULL
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_posture_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_mobility_performance_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_lifestyle_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_goals WHERE client_id = $1 AND is_active = true
          ORDER BY created_at DESC LIMIT 1`),
    one(`SELECT wa.start_date, wa.progress_pct, wp.id AS plan_id, wp.name AS plan_name,
                wp.duration_weeks,
                (SELECT COUNT(DISTINCT we.day_of_week) FROM workout_exercises we
                  WHERE we.workout_plan_id = wp.id AND we.week_number = 1)::int AS planned_days_count
           FROM workout_assignments wa
           JOIN workout_plans wp ON wp.id = wa.workout_plan_id
          WHERE wa.client_id = $1 AND wa.status = 'active'
          ORDER BY wa.start_date DESC LIMIT 1`),
    // Four weeks of the log, so "do they turn up" is answered from what was
    // performed rather than from the plan's own progress field.
    pool.query(
      `SELECT status FROM workout_sessions
        WHERE client_id = $1 AND session_date >= CURRENT_DATE - INTERVAL '28 days'`,
      [clientId],
    ).then((r) => r.rows),
  ]);

  res.json({
    data: buildBrief({
      client, parq, assessment, posture, mobility, lifestyle, goal, assignment, recentSessions: sessions,
    }),
  });
}));

// GET /clients/:id/snapshot
//
// What a trainer would otherwise have to remember about this client: whether
// the term is about to lapse, whether anyone has weighed them lately, whether
// last week's session happened, where they are against their goal.
//
// Every one of these was already derivable from data on the profile screen,
// and none of it was said out loud — so it lived in somebody's head, and the
// things that fall out of a head are the ones that cost a renewal.
router.get('/clients/:id/snapshot', auth, wrap(async (req, res) => {
  const clientId = req.params.id;
  const params = [clientId];
  const orgClause = orgWhere(req, params, 'c.organization_id');

  const { rows: clientRows } = await pool.query(
    `SELECT c.id, c.name, c.pt_end_date, c.balance_amount, c.organization_id
       FROM pt_clients c WHERE c.id = $1 AND c.deleted_at IS NULL ${orgClause}`,
    params,
  );
  const client = clientRows[0];
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const many = (sql) => pool.query(sql, [clientId]).then((r) => r.rows);
  const one = (sql) => many(sql).then((rows) => rows[0] ?? null);

  const [lifestyle, measurements, assessments, goal, prRows, lastSession, checkins] = await Promise.all([
    one(`SELECT sleep_category, sleep_duration_hours, recovery_score, recovery_risk
           FROM pt_lifestyle_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    many(`SELECT weight_kg, measured_at FROM pt_os_measurements
           WHERE client_id = $1 AND weight_kg IS NOT NULL
           ORDER BY measured_at DESC LIMIT 12`),
    many(`SELECT weight, assessment_date FROM pt_assessments
           WHERE client_id = $1 AND weight IS NOT NULL
           ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 12`),
    one(`SELECT goal_type, priority_goal, target_weight, starting_weight, target_date
           FROM pt_goals WHERE client_id = $1 AND is_active = true
          ORDER BY created_at DESC LIMIT 1`),
    // PR flags are written at log time against everything before them, so this
    // only reads them — recomputing here would disagree with the log.
    many(`SELECT wse.exercise_name, s.weight_kg, s.reps, ws.session_date
            FROM workout_sets s
            JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
            JOIN workout_sessions ws ON ws.id = wse.session_id
           WHERE ws.client_id = $1
             AND (s.is_pr_weight OR s.is_pr_reps OR s.is_pr_volume)
           ORDER BY ws.session_date DESC LIMIT 60`),
    one(`SELECT session_date, status FROM workout_sessions
          WHERE client_id = $1 AND session_date <= CURRENT_DATE
          ORDER BY session_date DESC LIMIT 1`),
    // Recovery rides along on the snapshot rather than getting its own call:
    // the profile opens both at once, and two round trips for one screen is
    // one more than it needs.
    many(`SELECT week_start_date, mood, sleep_hours, water_glasses,
                 stress_level, energy_level, soreness_level
            FROM weekly_checkins WHERE client_id = $1
           ORDER BY week_start_date DESC LIMIT 12`),
  ]);

  res.json({
    data: {
      ...buildSnapshot({
        client, lifestyle, measurements, assessments, goal, prRows, lastSession,
      }),
      recovery: buildRecovery(checkins),
    },
  });
}));

// POST /clients/:id/coach
//
// Coaching prompts written by a model, from readings this database can prove.
//
// POST, not GET, and on demand rather than on page load: a profile is opened
// dozens of times a day, mostly to check one thing, and an LLM call on every
// open is somebody's money and two seconds of spinner for an answer that has
// not changed since this morning.
//
// The facts are assembled first — the same snapshot and brief the profile
// already renders, both of which only ever report measurements that exist —
// and the model is asked to interpret them, not to supply them. If it is
// unconfigured, times out, or answers with something uncited, the derived
// prompts stand in: a coach card that vanishes when the API does teaches a
// trainer not to rely on it.
router.post('/clients/:id/coach', auth, wrap(async (req, res) => {
  const clientId = req.params.id;
  const params = [clientId];
  const orgClause = orgWhere(req, params, 'c.organization_id');

  const { rows: clientRows } = await pool.query(
    `SELECT c.id, c.name, c.gender, c.dob, c.goal, c.injuries, c.notes,
            c.pt_end_date, c.balance_amount, c.organization_id
       FROM pt_clients c WHERE c.id = $1 AND c.deleted_at IS NULL ${orgClause}`,
    params,
  );
  const client = clientRows[0];
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const many = (sql) => pool.query(sql, [clientId]).then((r) => r.rows);
  const one = (sql) => many(sql).then((rows) => rows[0] ?? null);

  const [lifestyle, measurements, assessments, goal, prRows, lastSession, parq, posture, mobility] =
    await Promise.all([
      one(`SELECT * FROM pt_lifestyle_assessments WHERE client_id = $1
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
      many(`SELECT weight_kg, measured_at FROM pt_os_measurements
             WHERE client_id = $1 AND weight_kg IS NOT NULL ORDER BY measured_at DESC LIMIT 12`),
      many(`SELECT * FROM pt_assessments WHERE client_id = $1
             ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 12`),
      one(`SELECT * FROM pt_goals WHERE client_id = $1 AND is_active = true
            ORDER BY created_at DESC LIMIT 1`),
      many(`SELECT wse.exercise_name, s.weight_kg, s.reps, ws.session_date
              FROM workout_sets s
              JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
              JOIN workout_sessions ws ON ws.id = wse.session_id
             WHERE ws.client_id = $1 AND (s.is_pr_weight OR s.is_pr_reps OR s.is_pr_volume)
             ORDER BY ws.session_date DESC LIMIT 60`),
      one(`SELECT session_date, status FROM workout_sessions
            WHERE client_id = $1 AND session_date <= CURRENT_DATE
            ORDER BY session_date DESC LIMIT 1`),
      one(`SELECT * FROM pt_parq_forms WHERE client_id = $1 AND deleted_at IS NULL
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
      one(`SELECT * FROM pt_posture_assessments WHERE client_id = $1
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
      one(`SELECT * FROM pt_mobility_performance_assessments WHERE client_id = $1
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    ]);

  const snapshot = buildSnapshot({
    client, lifestyle, measurements, assessments, goal, prRows, lastSession,
  });
  const brief = buildBrief({
    client, parq, assessment: assessments[0] ?? null, posture, mobility, lifestyle, goal,
    assignment: null, recentSessions: [],
  });

  const out = await generateCoach({
    snapshot,
    brief,
    client: brief.client,
    chat: routedChat,
    // The rule-based prompts are true whatever the model does, so they are
    // what the card falls back to rather than an empty state.
    fallback: snapshot.coach,
  });

  res.json({ data: out });
}));

// ─── Activity log ──────────────────────────────────────────
//
// The studio-facing view of activity_log — who changed what, when. The
// platform's own Audit Centre (mounted under /api/super-admin) reads the
// same table across every organization for the platform operator; this is
// the narrower, tenant-scoped read of it for a studio's own admin/manager,
// who has no reason to see (and must never be able to request) another
// studio's rows. Always filtered to the caller's own organization —
// scope.applyFilter's "no filter" case (a platform super admin operating
// platform-wide) is deliberately not offered here; that's what the Audit
// Centre is for.
router.get('/activity-log', auth, adminOrManager, wrap(async (req, res) => {
  const scope = tenantScope(req);
  const where = ['a.organization_id = $1'];
  const params = [scope.orgId];
  if (req.query.action) { params.push(req.query.action); where.push(`a.action = $${params.length}`); }
  if (req.query.entity_type) { params.push(req.query.entity_type); where.push(`a.entity_type = $${params.length}`); }
  if (req.query.entity_id) { params.push(req.query.entity_id); where.push(`a.entity_id = $${params.length}`); }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [rowsRes, countRes] = await Promise.all([
    pool.query(
      `SELECT a.id, a.user_id, a.user_name, a.action, a.entity_type, a.entity_id,
              a.old_data, a.new_data, a.created_at
         FROM activity_log a
        ${whereSql}
        ORDER BY a.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM activity_log a ${whereSql}`, params),
  ]);

  res.json({
    data: rowsRes.rows,
    paging: { limit, offset, total: countRes.rows[0].total, count: rowsRes.rows.length },
  });
}));

module.exports = router;
