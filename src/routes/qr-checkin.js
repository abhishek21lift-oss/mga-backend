// src/routes/qr-checkin.js
// QR Code check-in system — generation, scanning, dashboard, member history.
//
// GET  /api/qr/generate              — generate QR data URL for current user
// GET  /api/qr/generate/:type/:id    — generate QR for specific user (admin/trainer)
// POST /api/qr/scan                  — validate signed QR payload + mark attendance
// POST /api/qr/checkout              — check out (end gym visit)
// GET  /api/qr/dashboard             — live attendance dashboard stats
// GET  /api/qr/my-history            — member's own attendance history + streaks
// GET  /api/qr/staff-report          — staff/trainer attendance report (admin only)
'use strict';

const router   = require('express').Router();
const crypto   = require('crypto');
const QRCode   = require('qrcode');
const pool     = require('../db/pool');
const logger   = require('../lib/logger');
const { auth } = require('../middleware/auth');
const { requireStaff } = require('../middleware/rbac');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');

// ── AUD-004 (P1): this router is a MIXED surface ────────────────────────────
//
// Deliberately NOT gated at the mount, and that is the whole finding. Three
// routes here derive their subject from req.user and are self-scoped by
// construction — a client legitimately calls all three:
//
//   GET  /generate      the caller's OWN check-in QR
//   POST /checkout      closes the caller's OWN open attendance row
//   GET  /my-history    the caller's OWN attendance history
//
// Putting requireStaff on the mount (which is what the first pass at this
// finding proposed) would 403 a member trying to display their own check-in
// code — a client-facing outage introduced by a security fix.
//
// Two routes are studio-wide and get `requireStaff` individually, marked below:
//   POST /scan          marks ANYONE present from a signed payload
//   GET  /dashboard     live studio-wide attendance aggregates
//
// Two already carry their own RBAC and are left exactly as they are:
//   GET /generate/:type/:id   admin/manager/owner, or trainer for own client
//   GET /staff-report         inline admin check
//
// __tests__/security/qr.authz.test.js pins BOTH directions: the two staff
// routes refuse a client, and the three client routes keep working and stay
// self-scoped. The second half is what stops a future "just add requireStaff to
// the mount" from shipping.
const rateLimit = require('express-rate-limit');
const { makeStore } = require('../lib/rateLimitStore');

const qrLimiter = rateLimit({
  store: makeStore('qr'),
  passOnStoreError: true,
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function hmacSecret() {
  return process.env.KIOSK_HMAC_SECRET || process.env.JWT_SECRET || 'fallback-dev-only';
}

// Build a signed QR payload: base64(userId|userType|ts|sig)
// Static mode: ts = '0' (no expiry). Dynamic mode: ts = unix seconds.
function buildQrPayload(userId, userType, dynamic = false) {
  const ts = dynamic ? Math.floor(Date.now() / 1000).toString() : '0';
  const msg = `${userId}|${userType}|${ts}`;
  const sig = crypto.createHmac('sha256', hmacSecret()).update(msg).digest('hex');
  return Buffer.from(`${msg}|${sig}`).toString('base64url');
}

// Verify a QR payload. Returns { userId, userType } or throws.
function verifyQrPayload(payload, dynamicWindowSec = 300) {
  let decoded;
  try { decoded = Buffer.from(payload, 'base64url').toString('utf8'); }
  catch { throw new Error('Invalid QR payload encoding'); }

  const parts = decoded.split('|');
  if (parts.length !== 4) throw new Error('Malformed QR payload');
  const [userId, userType, ts, sig] = parts;

  const msg = `${userId}|${userType}|${ts}`;
  const expected = crypto.createHmac('sha256', hmacSecret()).update(msg).digest('hex');
  if (sig.length !== expected.length) {
    throw new Error('QR signature invalid');
  }
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error('QR signature invalid');
  }

  // Check expiry for dynamic QR (ts !== '0')
  if (ts !== '0') {
    const age = Math.floor(Date.now() / 1000) - parseInt(ts, 10);
    if (age > dynamicWindowSec || age < -60) throw new Error('QR code expired');
  }

  return { userId, userType };
}

async function generateQrDataUrl(userId, userType, dynamic = false) {
  const payload = buildQrPayload(userId, userType, dynamic);
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 300,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
}

// Note for membershipStatus() below: pt_clients has no expiry_date or
// subscription_end_date column, so pt_end_date is the only real expiry signal
// available.
/**
 * Resolve the person a scanned QR refers to — WITHIN the caller's studio.
 *
 * `orgId` is the caller's organization (null only for a platform super admin,
 * who legitimately sees everything). Every lookup is filtered by it, because
 * without that filter a scan returned the name, photo and package of a client
 * belonging to a different studio: QR payloads are signed with one
 * server-wide secret, so a code issued anywhere verifies everywhere, and the
 * only thing standing between studios was this query.
 *
 * The `clients` table is gone from here. It holds zero rows, has no
 * organization_id column at all — so it cannot be tenant-filtered even in
 * principle — and pt_clients is where members actually live.
 */
async function resolveUser(userId, userType, orgId) {
  // $2 IS NULL disables the filter for a super admin and applies it otherwise;
  // the same pattern the rest of the codebase uses for tenant scoping.
  if (userType === 'client') {
    const { rows } = await pool.query(
      `SELECT id, name, status, photo_url, client_id AS member_code, client_id,
              pt_end_date, package_type
         FROM pt_clients
        WHERE id = $1 AND deleted_at IS NULL
          AND ($2::uuid IS NULL OR organization_id = $2)
        LIMIT 1`,
      [userId, orgId]
    );
    return rows[0] ? { ...rows[0], _type: 'client' } : null;
  }
  if (userType === 'trainer') {
    const { rows } = await pool.query(
      `SELECT id, name, email, mobile FROM trainers
        WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2) LIMIT 1`,
      [userId, orgId]
    );
    return rows[0] ? { ...rows[0], status: 'active', _type: 'trainer' } : null;
  }
  // staff / user
  const { rows } = await pool.query(
    `SELECT id, name, email, role FROM users
      WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2) LIMIT 1`,
    [userId, orgId]
  );
  return rows[0] ? { ...rows[0], status: 'active', _type: userType } : null;
}

function membershipStatus(user) {
  if (!user) return 'not_found';
  if (user.status === 'frozen') return 'frozen';
  const today = new Date().toISOString().slice(0, 10);
  const exp = user.expiry_date || user.subscription_end_date || user.pt_end_date;
  if (exp && exp < today) return 'expired';
  if (user.status && user.status !== 'active') return user.status;
  return 'active';
}

/**
 * Write the check-in.
 *
 * organization_id is the CALLER's org, passed in — not a subquery on the
 * scanned person. It used to be
 *   COALESCE((SELECT organization_id FROM pt_clients WHERE id = ref_id), …)
 * which stamped the row with the TARGET's studio, so a scan performed by
 * studio A against a code from studio B wrote a row into studio B's data and
 * it showed up in their reports. routes/attendance.js has always used
 * orgIdOf(req) here; this path simply never adopted it.
 *
 * resolveUser has already refused to return anyone outside the caller's org,
 * so by the time we get here the two agree — this makes that explicit rather
 * than trusting the join.
 */
async function markAttendance(userId, userType, userName, method, deviceInfo, location, orgId) {
  const refType = userType === 'client' ? 'client' : userType === 'trainer' ? 'trainer' : 'staff';
  const date = new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `INSERT INTO attendance_logs
       (ref_id, ref_type, ref_name, date, check_in_time, method, status, notes, user_id, device_info, location, organization_id)
     VALUES ($1, $2, $3, $4::date, NOW(), $5, 'present', $6, $7, $8, $9, $10)
     ON CONFLICT (ref_id, ref_type, date) DO UPDATE
       SET check_in_time = COALESCE(attendance_logs.check_in_time, EXCLUDED.check_in_time),
           status        = 'present',
           method        = CASE WHEN attendance_logs.method = 'manual' THEN EXCLUDED.method
                                ELSE attendance_logs.method END,
           notes         = EXCLUDED.notes,
           organization_id = COALESCE(attendance_logs.organization_id, EXCLUDED.organization_id)
     RETURNING id, check_in_time`,
    [userId, refType, userName, date, method,
     `${method.toUpperCase()} check-in`, userId, deviceInfo || null, location || null, orgId]
  );
  return rows[0];
}

// ── GET /api/qr/generate ──────────────────────────────────────────────────────
// Generate QR for the currently authenticated user.
router.get('/generate', auth, qrLimiter, async (req, res) => {
  try {
    const u = req.user;
    let userId = u.id;
    let userType = 'user';

    // Map auth role to QR user type
    if (u.member_id) { userId = u.member_id; userType = 'client'; }
    else if (u.trainer_id) { userId = u.trainer_id; userType = 'trainer'; }
    else if (['admin', 'manager', 'staff', 'reception', 'receptionist'].includes(u.role)) {
      userType = 'staff';
    }

    const dynamic = req.query.dynamic === 'true';
    const dataUrl = await generateQrDataUrl(userId, userType, dynamic);
    const payload = buildQrPayload(userId, userType, dynamic);

    res.json({ dataUrl, payload, userId, userType, dynamic, expiresIn: dynamic ? 300 : null });
  } catch (err) {
    logger.error({ err: err.message }, 'QR generate error');
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// ── GET /api/qr/generate/:type/:id ───────────────────────────────────────────
// Generate QR for any user (admin or trainer for their clients).
router.get('/generate/:type/:id', auth, qrLimiter, async (req, res) => {
  try {
    const { type, id } = req.params;
    const allowed = ['client', 'trainer', 'staff', 'user'];
    if (!allowed.includes(type)) return res.status(400).json({ error: 'Invalid user type' });

    // RBAC
    const isAdmin = ['admin', 'manager', 'owner'].includes(req.user.role);
    const isTrainer = req.user.role === 'trainer';
    if (!isAdmin && !isTrainer) return res.status(403).json({ error: 'Not authorized' });

    // Trainers can only generate for their own clients (gym and PT)
    if (isTrainer && type === 'client') {
      const { rows } = await pool.query(
        `SELECT 1 FROM clients WHERE id = $1 AND trainer_id = $2
         UNION
         SELECT 1 FROM pt_clients WHERE id = $1 AND trainer_id = $2
         LIMIT 1`,
        [id, req.user.trainer_id]
      );
      if (!rows[0]) return res.status(403).json({ error: 'Client not assigned to you' });
    } else if (isTrainer && type !== 'client') {
      return res.status(403).json({ error: 'Trainers can only generate QR for their clients' });
    }

    const dynamic = req.query.dynamic === 'true';
    const dataUrl = await generateQrDataUrl(id, type, dynamic);
    const payload = buildQrPayload(id, type, dynamic);

    res.json({ dataUrl, payload, userId: id, userType: type, dynamic, expiresIn: dynamic ? 300 : null });
  } catch (err) {
    logger.error({ err: err.message }, 'QR generate/:type/:id error');
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// ── POST /api/qr/scan ─────────────────────────────────────────────────────────
// Validate signed QR payload and mark attendance. Called by scanner.
// Auth required (reception, kiosk, trainer, admin) OR kiosk token.
const scanLimiter = rateLimit({
  store: makeStore('qrscan'),
  passOnStoreError: true,
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// AUD-004: staff only. A signed QR marks whoever it names present, so this is
// the scanner's endpoint — reception, a kiosk, a trainer or an admin — never
// the person being scanned.
router.post('/scan', auth, requireStaff, scanLimiter, async (req, res) => {
  try {
    const { payload, device_info, location } = req.body;
    if (!payload) return res.status(400).json({ error: 'QR payload required' });

    let userId, userType;
    try {
      ({ userId, userType } = verifyQrPayload(payload));
    } catch (verifyErr) {
      return res.status(400).json({ error: verifyErr.message, success: false });
    }

    // A QR is signed with one server-wide secret, so a code minted by any
    // studio verifies at every studio. Resolve the person inside the caller's
    // org FIRST and bail if they are not there — before touching attendance,
    // and before echoing any of their details back. Doing the lookup up front
    // also stops the duplicate-scan branch below leaking a name for someone
    // the caller has no right to see.
    const orgId = orgIdOf(req);
    const user = await resolveUser(userId, userType, orgId);
    if (!user) return res.status(404).json({ error: 'User not found', success: false });

    // Duplicate scan prevention: check if already checked in today within 5 minutes
    const refType = userType === 'client' ? 'client' : userType === 'trainer' ? 'trainer' : 'staff';
    const { rows: recent } = await pool.query(
      `SELECT id, check_in_time FROM attendance_logs
       WHERE ref_id = $1 AND ref_type = $2 AND date = CURRENT_DATE
         AND check_in_time > NOW() - INTERVAL '5 minutes'
         AND ($3::uuid IS NULL OR organization_id = $3)
       LIMIT 1`,
      [userId, refType, orgId]
    );
    // The same shape on every outcome. The scanner draws the person's face on
    // the result card, and the branch that most needs a face is a rejection —
    // "membership expired" is a conversation the desk has to have with a
    // specific human standing in front of them, not with a name on a screen.
    // Nothing here is more sensitive than what the success branch already
    // returns, and `user` is only reached after resolveUser() has confirmed
    // the person belongs to the caller's org.
    const publicUser = (status) => ({
      id: userId,
      name: user.name,
      status,
      photo_url: user.photo_url || null,
      member_code: user.member_code || user.client_id || null,
      package_type: user.package_type || null,
      role: user.role || userType,
    });

    if (recent[0]) {
      return res.json({
        success: true,
        duplicate: true,
        message: `Already checked in (${new Date(recent[0].check_in_time).toLocaleTimeString()})`,
        user: publicUser('active'),
        attendance_id: recent[0].id,
        check_in_time: recent[0].check_in_time,
      });
    }

    const status = membershipStatus(user);
    if (status !== 'active' && userType === 'client') {
      return res.json({
        success: false,
        message: `Membership ${status}`,
        user: publicUser(status),
      });
    }

    const att = await markAttendance(userId, userType, user.name, 'qr', device_info, location, orgId);

    return res.json({
      success: true,
      message: `Welcome, ${user.name}!`,
      user: publicUser(status),
      attendance_id: att?.id,
      check_in_time: att?.check_in_time,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'QR scan error');
    res.status(500).json({ error: 'Server error', success: false });
  }
});

// ── POST /api/qr/checkout ─────────────────────────────────────────────────────
// Marks check-out time for the current user's today attendance record.
router.post('/checkout', auth, async (req, res) => {
  try {
    const u = req.user;
    let userId = u.id;
    let refType = 'staff';

    if (u.member_id) { userId = u.member_id; refType = 'client'; }
    else if (u.trainer_id) { userId = u.trainer_id; refType = 'trainer'; }

    const { rows } = await pool.query(
      `UPDATE attendance_logs
          SET check_out_time = NOW()
        WHERE ref_id = $1 AND ref_type = $2 AND date = CURRENT_DATE
          AND check_out_time IS NULL
        RETURNING id, check_in_time, check_out_time`,
      [userId, refType]
    );

    if (!rows[0]) return res.json({ success: false, message: 'No active check-in found for today' });

    const duration = rows[0].check_in_time
      ? Math.round((new Date(rows[0].check_out_time) - new Date(rows[0].check_in_time)) / 60000)
      : null;

    res.json({
      success: true,
      message: 'Checked out successfully',
      attendance_id: rows[0].id,
      duration_minutes: duration,
      check_out_time: rows[0].check_out_time,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'QR checkout error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/qr/dashboard ─────────────────────────────────────────────────────
// Live attendance dashboard: currently inside, today's count, peak hours, breakdown.
// AUD-004: staff only. Studio-wide aggregates — who is inside right now,
// today's totals, peak hours — across every client the studio has.
router.get('/dashboard', auth, requireStaff, async (req, res) => {
  try {
    // Tenant scope: every aggregate below is limited to the caller's org.
    const scope = tenantScope(req);
    const oParams = scope.applyFilter ? [scope.orgId] : [];
    const oc = scope.applyFilter ? ' AND organization_id = $1' : '';   // bare tables
    const ocA = scope.applyFilter ? ' AND a.organization_id = $1' : ''; // aliased `a`

    const [todayStats, currentlyInside, hourlyBreakdown, weeklyTrend, methodBreakdown] =
      await Promise.all([
        // Today's totals by ref_type
        pool.query(
          `SELECT ref_type,
                  COUNT(*) FILTER (WHERE status = 'present') AS present,
                  COUNT(*) FILTER (WHERE status = 'late')    AS late,
                  COUNT(*) FILTER (WHERE status = 'absent')  AS absent,
                  COUNT(*)                                    AS total
             FROM attendance_logs
            WHERE date = CURRENT_DATE${oc}
            GROUP BY ref_type`, oParams
        ),

        // Currently inside (checked in today, not checked out)
        pool.query(
          `SELECT ref_type, COUNT(*) AS count
             FROM attendance_logs
            WHERE date = CURRENT_DATE
              AND check_in_time IS NOT NULL
              AND check_out_time IS NULL
              AND status = 'present'${oc}
            GROUP BY ref_type`, oParams
        ),

        // Hourly check-in distribution for today
        pool.query(
          `SELECT EXTRACT(HOUR FROM check_in_time)::int AS hour, COUNT(*) AS count
             FROM attendance_logs
            WHERE date = CURRENT_DATE AND check_in_time IS NOT NULL${oc}
            GROUP BY hour ORDER BY hour`, oParams
        ),

        // Past 7 days total check-ins (trend)
        pool.query(
          `SELECT date, COUNT(*) FILTER (WHERE status = 'present') AS present
             FROM attendance_logs
            WHERE date >= CURRENT_DATE - INTERVAL '6 days'${oc}
            GROUP BY date ORDER BY date`, oParams
        ),

        // Check-in method breakdown today
        pool.query(
          `SELECT method, COUNT(*) AS count
             FROM attendance_logs
            WHERE date = CURRENT_DATE AND status = 'present'${oc}
            GROUP BY method`, oParams
        ),
      ]);

    // Recent check-ins (last 20) with user info. `clients` is legacy/empty
    // in this deployment — real client rows live in pt_clients.
    const { rows: recent } = await pool.query(
      `SELECT a.id, a.ref_id, a.ref_type, a.ref_name, a.check_in_time, a.check_out_time,
              a.method, a.status,
              COALESCE(c.photo_url, pc.photo_url) AS photo_url,
              COALESCE(c.member_code, pc.client_id) AS member_code,
              COALESCE(c.status, pc.status) AS membership_status
         FROM attendance_logs a
         LEFT JOIN clients c ON c.id = a.ref_id AND a.ref_type = 'client'
         LEFT JOIN pt_clients pc ON pc.id = a.ref_id AND a.ref_type = 'client' AND pc.deleted_at IS NULL
        WHERE a.date = CURRENT_DATE AND a.status = 'present'${ocA}
        ORDER BY a.check_in_time DESC NULLS LAST
        LIMIT 20`, oParams
    );

    const todayMap = {};
    for (const r of todayStats.rows) {
      todayMap[r.ref_type] = {
        present: parseInt(r.present),
        late:    parseInt(r.late),
        absent:  parseInt(r.absent),
        total:   parseInt(r.total),
      };
    }

    const insideMap = {};
    for (const r of currentlyInside.rows) insideMap[r.ref_type] = parseInt(r.count);

    const totalInside = Object.values(insideMap).reduce((s, v) => s + v, 0);
    const totalToday  = todayStats.rows.reduce((s, r) => s + parseInt(r.present) + parseInt(r.late), 0);

    res.json({
      currently_inside: { total: totalInside, breakdown: insideMap },
      today: { total: totalToday, breakdown: todayMap },
      hourly: hourlyBreakdown.rows.map((r) => ({ hour: r.hour, count: parseInt(r.count) })),
      weekly_trend: weeklyTrend.rows.map((r) => ({ date: r.date, present: parseInt(r.present) })),
      method_breakdown: methodBreakdown.rows.map((r) => ({ method: r.method, count: parseInt(r.count) })),
      recent_checkins: recent,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Dashboard error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/qr/my-history ────────────────────────────────────────────────────
// Member's own attendance history with streak calculation.
router.get('/my-history', auth, async (req, res) => {
  try {
    const u = req.user;
    let refId = u.id;
    let refType = 'staff';

    if (u.member_id) { refId = u.member_id; refType = 'client'; }
    else if (u.trainer_id) { refId = u.trainer_id; refType = 'trainer'; }

    const limit = Math.min(parseInt(req.query.limit || '90'), 365);
    const { rows } = await pool.query(
      `SELECT date, status, check_in_time, check_out_time, method, duration_minutes
         FROM attendance_logs
        WHERE ref_id = $1 AND ref_type = $2
        ORDER BY date DESC
        LIMIT $3`,
      [refId, refType, limit]
    );

    // Calculate streaks
    const presentDates = new Set(
      rows.filter((r) => r.status === 'present' || r.status === 'late').map((r) => r.date)
    );

    let currentStreak = 0;
    let longestStreak = 0;
    let tempStreak = 0;
    const d = new Date();

    // Walk backwards from today
    for (let i = 0; i < 365; i++) {
      const dateStr = d.toISOString().slice(0, 10);
      if (presentDates.has(dateStr)) {
        tempStreak++;
        if (i === 0 || (i === 1 && tempStreak > 0)) currentStreak = tempStreak;
        longestStreak = Math.max(longestStreak, tempStreak);
      } else {
        if (i < 2) currentStreak = 0;
        if (tempStreak > longestStreak) longestStreak = tempStreak;
        tempStreak = 0;
        if (i > 0) break;
      }
      d.setDate(d.getDate() - 1);
    }

    const totalPresent = rows.filter((r) => r.status === 'present' || r.status === 'late').length;
    const totalDays    = rows.length;
    const thisMonthRows = rows.filter((r) => {
      const month = new Date().toISOString().slice(0, 7);
      return r.date && r.date.toString().startsWith(month);
    });
    const thisMonthPresent = thisMonthRows.filter((r) => r.status === 'present' || r.status === 'late').length;

    // Avg duration if tracked
    const durRows = rows.filter((r) => r.duration_minutes > 0);
    const avgDuration = durRows.length
      ? Math.round(durRows.reduce((s, r) => s + r.duration_minutes, 0) / durRows.length)
      : null;

    res.json({
      history: rows,
      stats: {
        total_present: totalPresent,
        total_days: totalDays,
        current_streak: currentStreak,
        longest_streak: longestStreak,
        this_month: thisMonthPresent,
        attendance_rate: totalDays ? Math.round((totalPresent / totalDays) * 100) : 0,
        avg_duration_minutes: avgDuration,
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'My-history error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/qr/staff-report ──────────────────────────────────────────────────
// Admin report of staff/trainer attendance for a given period.
router.get('/staff-report', auth, async (req, res) => {
  try {
    const isAdmin = ['admin', 'manager', 'owner'].includes(req.user.role);
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

    const from  = req.query.from || new Date().toISOString().slice(0, 7) + '-01';
    const to    = req.query.to   || new Date().toISOString().slice(0, 10);
    const type  = req.query.type || 'all'; // client|trainer|staff|all

    const conds = ['date >= $1::date', 'date <= $2::date'];
    const params = [from, to];
    if (type !== 'all') {
      params.push(type);
      conds.push(`ref_type = $${params.length}`);
    }
    const scope = tenantScope(req);
    if (scope.applyFilter) { params.push(scope.orgId); conds.push(`organization_id = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT ref_id, ref_name, ref_type,
              COUNT(*)                                    AS total_days,
              COUNT(*) FILTER (WHERE status = 'present') AS present,
              COUNT(*) FILTER (WHERE status = 'late')    AS late,
              COUNT(*) FILTER (WHERE status = 'absent')  AS absent,
              ROUND(AVG(duration_minutes))                AS avg_duration_min,
              MIN(check_in_time::time)                   AS earliest_checkin,
              MAX(check_in_time::time)                   AS latest_checkin
         FROM attendance_logs
        WHERE ${conds.join(' AND ')}
        GROUP BY ref_id, ref_name, ref_type
        ORDER BY ref_name`,
      params
    );

    res.json({ data: rows, from, to, type });
  } catch (err) {
    logger.error({ err: err.message }, 'Staff report error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
