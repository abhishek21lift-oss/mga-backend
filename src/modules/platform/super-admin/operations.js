'use strict';
// Platform overview, activity and audit — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  TENANT_ROLES, audit, csvCell, invalidateUserCache, pool,
} = require('./shared');
// ── GET /overview ─────────────────────────────────────────────────────────────
// Cross-studio command-centre dashboard: one row of KPIs per studio plus rolled-
// up platform totals. Revenue is collected cash (SUM paid_amount); outstanding is
// balances still owed. Sessions counted for the current calendar month.
router.get('/overview', async (req, res, next) => {
  try {
    const { rows: studios } = await pool.query(`
      SELECT o.id, o.name, o.slug, o.status, o.logo_url, o.created_at,
        (SELECT count(*) FROM users u
           WHERE u.organization_id = o.id AND u.deleted_at IS NULL AND u.role = 'admin')::int              AS admin_count,
        (SELECT max(u.last_login) FROM users u
           WHERE u.organization_id = o.id AND u.deleted_at IS NULL)                                        AS last_login,
        (SELECT count(*) FROM pt_clients c
           WHERE c.organization_id = o.id AND c.deleted_at IS NULL)::int                                   AS total_clients,
        (SELECT count(*) FROM pt_clients c
           WHERE c.organization_id = o.id AND c.deleted_at IS NULL AND c.status = 'active')::int           AS active_clients,
        (SELECT COALESCE(SUM(c.paid_amount), 0) FROM pt_clients c
           WHERE c.organization_id = o.id AND c.deleted_at IS NULL)                                        AS revenue,
        (SELECT COALESCE(SUM(c.balance_amount), 0) FROM pt_clients c
           WHERE c.organization_id = o.id AND c.deleted_at IS NULL)                                        AS outstanding,
        (SELECT count(*) FROM pt_sessions s
           WHERE s.organization_id = o.id AND s.session_date >= date_trunc('month', CURRENT_DATE))::int    AS sessions_this_month
      FROM organizations o
      ORDER BY o.created_at DESC`);

    const totals = studios.reduce((t, s) => ({
      studios: t.studios + 1,
      active_studios: t.active_studios + (s.status === 'active' ? 1 : 0),
      suspended_studios: t.suspended_studios + (s.status === 'suspended' ? 1 : 0),
      total_clients: t.total_clients + Number(s.total_clients || 0),
      active_clients: t.active_clients + Number(s.active_clients || 0),
      revenue: t.revenue + Number(s.revenue || 0),
      outstanding: t.outstanding + Number(s.outstanding || 0),
      sessions_this_month: t.sessions_this_month + Number(s.sessions_this_month || 0),
    }), {
      studios: 0, active_studios: 0, suspended_studios: 0, total_clients: 0,
      active_clients: 0, revenue: 0, outstanding: 0, sessions_this_month: 0,
    });

    res.json({ data: { totals, studios } });
  } catch (err) { next(err); }
});

// ── GET /activity ─────────────────────────────────────────────────────────────
// Platform-wide audit feed. Filter by studio (org_id), user, or action. The
// activity_log has no org column, so studio is resolved through the acting user.
router.get('/activity', async (req, res, next) => {
  try {
    const orgId  = req.query.org_id  || null;
    const userId = req.query.user_id || null;
    const action = req.query.action  || null;
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows } = await pool.query(`
      SELECT a.id, a.user_id, a.user_name, a.action, a.entity_type, a.entity_id,
             a.new_data, a.ip_address, a.created_at,
             u.organization_id, o.name AS organization_name
        FROM activity_log a
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE ($1::uuid IS NULL OR u.organization_id = $1::uuid)
         AND ($2::text IS NULL OR a.user_id = $2::text)
         AND ($3::text IS NULL OR a.action = $3)
       ORDER BY a.created_at DESC
       LIMIT $4 OFFSET $5`,
      [orgId, userId, action, limit, offset]
    );
    res.json({ data: rows, paging: { limit, offset, count: rows.length } });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN MANAGEMENT — operator actions on a studio's login accounts
//
//  These sit beside the existing reset-password / activate-deactivate
//  handlers above. All four are platform-only and every one is audited.
// ═══════════════════════════════════════════════════════════════════════════

// Loads a tenant user, refusing to touch a super_admin. The tenant portal must
// never be able to act on a platform operator's own account — same guard the
// existing user handlers apply.
async function loadTenantUser(id) {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, organization_id FROM users WHERE id = $1 AND deleted_at IS NULL`, [id]
  );
  const u = rows[0];
  if (!u) return { error: 'NOT_FOUND' };
  if (!TENANT_ROLES.includes(u.role)) return { error: 'FORBIDDEN' };
  return { user: u };
}

// ── POST /users/:id/force-logout ─────────────────────────────────────────────
// Revokes every live session for one account by bumping token_version, which
// the auth middleware compares against the claim in each JWT. Deliberately
// does not touch the password: "sign this person out everywhere" and "lock
// them out" are different operator intents and conflating them is how support
// accidentally locks a paying admin out of their own studio.
router.post('/users/:id/force-logout', async (req, res, next) => {
  try {
    const { user, error } = await loadTenantUser(req.params.id);
    if (error === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    if (error === 'FORBIDDEN') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot act on a platform account' } });

    const { rows } = await pool.query(
      `UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1
       RETURNING id, token_version`, [req.params.id]
    );
    invalidateUserCache();
    await audit(req, 'user_force_logout', 'user', req.params.id,
      { email: user.email, organization_id: user.organization_id, token_version: rows[0].token_version });
    res.json({ data: { id: rows[0].id, message: 'All sessions revoked' } });
  } catch (err) { next(err); }
});

// ── POST /users/:id/reset-mfa ────────────────────────────────────────────────
// Clears the enrolled authenticator so a locked-out admin can re-enrol. This is
// a support action with real weight — it removes a security factor — so it is
// audited with the previous state, and sessions are revoked alongside it: an
// existing session would otherwise outlive the factor that authorised it.
router.post('/users/:id/reset-mfa', async (req, res, next) => {
  try {
    const { user, error } = await loadTenantUser(req.params.id);
    if (error === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    if (error === 'FORBIDDEN') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot act on a platform account' } });

    const { rows: before } = await pool.query(
      'SELECT mfa_enabled FROM user_profiles WHERE user_id = $1', [req.params.id]
    );
    const wasEnabled = !!(before[0] && before[0].mfa_enabled);

    await pool.query(
      `UPDATE user_profiles SET mfa_enabled = FALSE, mfa_secret = NULL WHERE user_id = $1`, [req.params.id]
    );
    await pool.query(
      `UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1`, [req.params.id]
    );
    invalidateUserCache();

    await audit(req, 'user_mfa_reset', 'user', req.params.id,
      { email: user.email, organization_id: user.organization_id, was_enabled: wasEnabled });
    res.json({ data: { id: req.params.id, was_enabled: wasEnabled, message: 'Two-factor reset; sessions revoked' } });
  } catch (err) { next(err); }
});

// ── POST /organizations/:id/subscription/bonus-days ──────────────────────────
// Extends the current period (or the trial, when still on one) by N days.
// Separate from PATCH .../expiry, which sets an absolute date: goodwill is
// expressed as "give them another 14 days", and making the operator compute
// the target date by hand is how off-by-one credits happen. The delta is what
// gets audited, so the reason for the new date stays legible later.
const BONUS_DAYS_MAX = 365;

router.post('/organizations/:id/subscription/bonus-days', async (req, res, next) => {
  try {
    const days = parseInt(req.body.days, 10);
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > BONUS_DAYS_MAX) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: `days must be a non-zero integer within ±${BONUS_DAYS_MAX}` },
      });
    }

    const { rows: orgRows } = await pool.query(
      `SELECT id, name, subscription_status, trial_ends_at, current_period_end
         FROM organizations WHERE id = $1`, [req.params.id]
    );
    const org = orgRows[0];
    if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

    // Extend whichever clock the studio is actually on. A trialling studio has
    // no period end to move, and moving the wrong one silently does nothing.
    const onTrial = org.subscription_status === 'trial' || org.subscription_status === 'trial_expired';
    const field = onTrial ? 'trial_ends_at' : 'current_period_end';
    const current = onTrial ? org.trial_ends_at : org.current_period_end;

    // Extending from today (not from a date already in the past) is what an
    // operator means by "give them 14 more days" on an expired account.
    const base = current && new Date(current) > new Date() ? new Date(current) : new Date();
    const next = new Date(base.getTime() + days * 86400000);

    await pool.query(`UPDATE organizations SET ${field} = $2 WHERE id = $1`, [req.params.id, next.toISOString()]);
    invalidateUserCache();

    await audit(req, 'subscription_bonus_days', 'organization', req.params.id, {
      days, field, from: current, to: next.toISOString(), reason: req.body.reason || null,
    });
    res.json({ data: { id: req.params.id, field, previous: current, [field]: next.toISOString(), days } });
  } catch (err) { next(err); }
});

// ── GET / PUT /organizations/:id/notes ───────────────────────────────────────
// Operator-only scratchpad. Never surfaced on any tenant-facing endpoint — the
// studio's own admins must not see what the platform wrote about them.
router.get('/organizations/:id/notes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT internal_notes, internal_notes_updated_at, internal_notes_updated_by
         FROM organizations WHERE id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

const NOTES_MAX = 20000;

router.put('/organizations/:id/notes', async (req, res, next) => {
  try {
    const notes = typeof req.body.notes === 'string' ? req.body.notes : '';
    if (notes.length > NOTES_MAX) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `notes must be ${NOTES_MAX} characters or fewer` } });
    }

    const { rows: before } = await pool.query('SELECT internal_notes FROM organizations WHERE id = $1', [req.params.id]);
    if (!before[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

    const { rows } = await pool.query(
      `UPDATE organizations
          SET internal_notes = $2, internal_notes_updated_at = NOW(), internal_notes_updated_by = $3
        WHERE id = $1
        RETURNING internal_notes, internal_notes_updated_at, internal_notes_updated_by`,
      [req.params.id, notes || null, req.user?.name || req.user?.id || null]
    );

    // Length only, not content: the note is operator commentary about a
    // customer and copying it wholesale into a second table is needless
    // duplication of something that may name individuals.
    await audit(req, 'org_notes_updated', 'organization', req.params.id, {
      previous_length: (before[0].internal_notes || '').length,
      new_length: notes.length,
    });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  AUDIT CENTRE
//
//  /activity above is the dashboard's recent-events feed: newest 50, three
//  optional filters, no total. The Audit Centre is the investigative view —
//  "what did this operator change on that studio last Tuesday, and what was
//  the value before?" — so it adds a time window, entity filter, free-text
//  search, a real total for pagination, and old_data alongside new_data.
//  Kept as separate routes rather than growing /activity, so the dashboard
//  feed stays cheap (no COUNT) and its contract is unchanged.
// ═══════════════════════════════════════════════════════════════════════════

// Builds the shared WHERE clause + params for both the list and the export, so
// a CSV can never disagree with the table it was exported from.
function buildAuditFilter(query) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

  if (query.org_id)      add('u.organization_id = $?::uuid', query.org_id);
  if (query.user_id)     add('a.user_id = $?', query.user_id);
  if (query.action)      add('a.action = $?', query.action);
  if (query.entity_type) add('a.entity_type = $?', query.entity_type);
  if (query.from)        add('a.created_at >= $?::timestamptz', query.from);
  // `to` is treated as an inclusive day: the UI sends a date, and an operator
  // asking for activity "to the 5th" means through the end of the 5th.
  if (query.to)          add('a.created_at < ($?::date + INTERVAL \'1 day\')', query.to);
  if (query.q) {
    params.push(`%${query.q}%`);
    const i = params.length;
    where.push(`(a.user_name ILIKE $${i} OR a.action ILIKE $${i} OR a.entity_id ILIKE $${i} OR o.name ILIKE $${i})`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const AUDIT_SELECT = `
  SELECT a.id, a.user_id, a.user_name, a.action, a.entity_type, a.entity_id,
         a.old_data, a.new_data, a.ip_address, a.user_agent, a.created_at,
         u.organization_id, o.name AS organization_name
    FROM activity_log a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN organizations o ON o.id = u.organization_id`;

// ── GET /audit ───────────────────────────────────────────────────────────────
router.get('/audit', async (req, res, next) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { clause, params } = buildAuditFilter(req.query);

    // One round trip for the page and one for the total. The count is needed
    // for pagination; running it in parallel keeps the added latency off the
    // critical path rather than doubling it.
    const [rowsRes, countRes] = await Promise.all([
      pool.query(`${AUDIT_SELECT} ${clause} ORDER BY a.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]),
      pool.query(`SELECT COUNT(*)::int AS total FROM activity_log a
                    LEFT JOIN users u ON u.id = a.user_id
                    LEFT JOIN organizations o ON o.id = u.organization_id ${clause}`, params),
    ]);

    res.json({
      data: rowsRes.rows,
      paging: { limit, offset, total: countRes.rows[0].total, count: rowsRes.rows.length },
    });
  } catch (err) { next(err); }
});

// ── GET /audit/filters ───────────────────────────────────────────────────────
// Distinct actions and entity types actually present, so the filter dropdowns
// offer what exists rather than a hardcoded list that drifts from reality.
router.get('/audit/filters', async (req, res, next) => {
  try {
    const [actions, entities] = await Promise.all([
      pool.query(`SELECT DISTINCT action AS v FROM activity_log WHERE action IS NOT NULL AND action <> '' ORDER BY 1`),
      pool.query(`SELECT DISTINCT entity_type AS v FROM activity_log WHERE entity_type IS NOT NULL AND entity_type <> '' ORDER BY 1`),
    ]);
    res.json({ actions: actions.rows.map(r => r.v), entity_types: entities.rows.map(r => r.v) });
  } catch (err) { next(err); }
});

// ── GET /audit/export ────────────────────────────────────────────────────────
// CSV of the *same* filtered set, capped so one click cannot stream an
// unbounded table into memory. Honours the identical filter builder as the
// list route, so the export always matches what the operator is looking at.
const AUDIT_EXPORT_MAX = 10000;


router.get('/audit/export', async (req, res, next) => {
  try {
    const { clause, params } = buildAuditFilter(req.query);
    const { rows } = await pool.query(
      `${AUDIT_SELECT} ${clause} ORDER BY a.created_at DESC LIMIT $${params.length + 1}`,
      [...params, AUDIT_EXPORT_MAX]
    );

    const header = ['Timestamp', 'Actor', 'Actor ID', 'Studio', 'Action', 'Entity Type',
                    'Entity ID', 'Previous Value', 'New Value', 'IP', 'User Agent'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push([
        r.created_at ? new Date(r.created_at).toISOString() : '',
        r.user_name, r.user_id, r.organization_name, r.action, r.entity_type,
        r.entity_id, r.old_data, r.new_data, r.ip_address, r.user_agent,
      ].map(csvCell).join(','));
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${stamp}.csv"`);
    // Exporting the audit trail is itself an auditable act.
    await audit(req, 'audit_exported', 'audit_log', null, { rows: rows.length, filters: req.query });
    // BOM so Excel opens UTF-8 names correctly instead of mojibake.
    res.send('﻿' + lines.join('\n'));
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SYSTEM HEALTH
//
//  Live introspection, deliberately with no table of its own: anything
//  persisted here would be a second copy of the truth that can go stale.
//  Everything below is measured at request time.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/system-health', async (req, res, next) => {
  try {
    const started = Date.now();
    let db = { status: 'down', latency_ms: null, error: null };
    let migrations = { applied: null, latest: null, applied_at: null };
    let dbSize = null;

    try {
      const t0 = Date.now();
      await pool.query('SELECT 1');
      db = { status: 'up', latency_ms: Date.now() - t0, error: null };

      const [mig, size] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS applied,
                           (SELECT filename   FROM _migrations ORDER BY id DESC LIMIT 1) AS latest,
                           (SELECT applied_at FROM _migrations ORDER BY id DESC LIMIT 1) AS applied_at
                      FROM _migrations`),
        pool.query(`SELECT pg_database_size(current_database())::bigint AS bytes`),
      ]);
      migrations = mig.rows[0];
      dbSize = Number(size.rows[0].bytes);
    } catch (err) {
      db = { status: 'down', latency_ms: null, error: err.message };
    }

    // Error volume over the last 24h, read from the audit trail rather than
    // log files — log files are not queryable from here and rotate away.
    let errors24h = null;
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM activity_log
          WHERE created_at > NOW() - INTERVAL '24 hours' AND action ILIKE '%fail%'`);
      errors24h = rows[0].n;
    } catch { /* non-fatal: health must still render if this query fails */ }

    const mem = process.memoryUsage();

    // BullMQ queue snapshot (Redis-backed workers). Measured at request time
    // like everything else here; never fatal — an unreachable queue shows up
    // as status 'unknown' rather than failing the whole health endpoint.
    let queues = null;
    try {
      const { collectQueueStats, summarize } = require('../../../lib/queueHealth');
      queues = summarize(await collectQueueStats());
    } catch {
      queues = { status: 'unknown', detail: 'unavailable' };
    }

    res.json({
      checked_at: new Date().toISOString(),
      check_duration_ms: Date.now() - started,
      database: {
        ...db,
        size_bytes: dbSize,
        pool: { total: pool.totalCount ?? null, idle: pool.idleCount ?? null, waiting: pool.waitingCount ?? null },
      },
      migrations,
      process: {
        uptime_seconds: Math.round(process.uptime()),
        node_version: process.version,
        app_version: process.env.npm_package_version || null,
        environment: process.env.NODE_ENV || 'development',
        memory: {
          rss_bytes: mem.rss,
          heap_used_bytes: mem.heapUsed,
          heap_total_bytes: mem.heapTotal,
        },
      },
      queues,
      errors_24h: errors24h,
    });
  } catch (err) { next(err); }
});

module.exports = router;
