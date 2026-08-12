// src/routes/upi-payments.js
//
// HTTP surface for manual UTR verification payments.
//
// Mounted at /api/payments/upi — a sub-resource of the existing finance
// payments router rather than a replacement for it. /api/payments is the
// studio's cash ledger (GET /, POST /, GET /stats, DELETE /:id) and stays
// exactly as it was; this adds the member-facing UPI collection flow beside
// it. The mount in server.js must come BEFORE the ledger router, or Express
// will hand /api/payments/upi/... to the ledger's DELETE /:id.
//
// ── The trust model ─────────────────────────────────────────────────────────
// Nothing the browser sends is trusted for anything that decides money:
//   • The AMOUNT is never read from the request. It is computed from the plan
//     and the studio's GST setting at creation time and stored; the payment
//     page renders the stored figure, and approval uses the stored figure.
//   • The UPI ID and merchant name come from payment_settings, never from the
//     client, so a tampered payload cannot redirect a member's money.
//   • The screenshot URL is a server-generated storage key. A caller can only
//     upload bytes; it cannot name where they land or claim a URL it did not
//     produce.
//   • Approval is admin-only, tenant-scoped, and conditional on the row still
//     being pending — see lib/upiPayments.js.
'use strict';

const router = require('express').Router();
const multer = require('multer');
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { z } = require('../lib/validation');
const { tenantScope } = require('../lib/tenant-db');
const { saveFile } = require('../lib/fileStorage');
const { logActivity } = require('../lib/activityLog');
const logger = require('../lib/logger');
const upi = require('../lib/upiPayments');
const { generateUpiReceiptPdf } = require('../lib/upiReceiptPdf');

// ── Upload constraints ──────────────────────────────────────────────────────
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB, per spec

// Magic-byte signatures. The multipart Content-Type header is attacker
// controlled — the same pattern is used for PAR-Q documents and org logos —
// so the header only gates the cheap rejection and the bytes decide.
const FILE_SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'application/pdf', ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] },
];

function detectFileType(buf) {
  for (const sig of FILE_SIGNATURES) {
    if (sig.magic.every((b, i) => buf[i] === b)) return sig;
  }
  return null;
}

const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g)$|^application\/pdf$/i.test(file.mimetype || '')) {
      return cb(new Error('Only JPG, PNG or PDF files are allowed'));
    }
    cb(null, true);
  },
});

// ── Schemas ─────────────────────────────────────────────────────────────────

// 12-16 numeric digits. NPCI issues 12; several PSP apps surface a longer
// internal reference, so the window is deliberately wider than the spec's
// minimum rather than rejecting references members can genuinely see.
const utrSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{12,16}$/, 'UPI reference must be 12 to 16 digits');

const uuidSchema = z.string().uuid('Invalid id');

// Free text that ends up in a PDF and in the admin's browser. Length-capped
// and control characters stripped; the app-wide sanitize middleware handles
// HTML escaping, and every render path is React or pdfkit text (neither of
// which interprets markup), so this is belt to that braces.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
const safeText = (max) =>
  z.string().trim().max(max)
    .transform((v) => v.replace(CONTROL_CHARS, ''))
    .optional().nullable();

// z.coerce.boolean() treats the STRING "false" as true, because a non-empty
// string is truthy — and multipart/query payloads send exactly that. The
// coercion is therefore spelled out rather than inferred.
const boolish = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1'),
]);

// plans.duration is an enum of words, not a number of months.
const DURATION_MONTHS = Object.freeze({
  'Monthly': 1, 'Quarterly': 3, 'Half Yearly': 6, 'Yearly': 12,
});

// Mime types /upload can legitimately have returned. Echoed back by the
// client, so it is checked against this list rather than stored as sent.
const ALLOWED_PROOF_MIME = ['image/jpeg', 'image/png', 'application/pdf'];

const schemas = {
  createOrder: {
    body: z.object({
      // Optional: a member is always resolved from their own session and
      // neither knows nor may choose a client_id. Staff creating an order at
      // the desk must supply one — resolveTargetClient() enforces that.
      client_id: z.string().min(1).max(64).optional().nullable(),
      plan_id: z.string().max(64).optional().nullable(),
      plan_name: z.string().trim().min(1, 'Plan name is required').max(160),
      duration_months: z.coerce.number().int().min(1).max(120),
      // Present so a studio can sell an ad-hoc package, but see the handler:
      // when plan_id resolves to a real plan the STORED price wins and this is
      // ignored, so a tampered payload cannot buy a plan at its own price.
      base_amount: z.coerce.number().min(0).max(10_000_000),
      notes: safeText(500),
    }),
  },
  submitUtr: {
    params: z.object({ id: uuidSchema }),
    body: z.object({
      utr: utrSchema,
      // Echoed back from POST /upload. Both are re-checked in the handler —
      // the key against the issuing order, the mime against the allowlist —
      // because everything here crossed the client.
      screenshot_url: z.string().max(300).optional().nullable(),
      screenshot_mime: z.enum(['image/jpeg', 'image/png', 'application/pdf']).optional().nullable(),
      notes: safeText(500),
    }),
  },
  idParam: { params: z.object({ id: uuidSchema }) },
  reject: {
    params: z.object({ id: uuidSchema }),
    body: z.object({
      reason: z.enum(['DUPLICATE_UTR', 'WRONG_UTR', 'PAYMENT_NOT_RECEIVED',
                      'AMOUNT_MISMATCH', 'FAKE_SCREENSHOT', 'OTHER']),
      note: safeText(500),
    }),
  },
  settings: {
    body: z.object({
      upi_id: z.string().trim().regex(
        /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.]{1,63}$/,
        'UPI ID must look like name@bank'
      ),
      merchant_name: z.string().trim().min(1, 'Merchant name is required').max(120),
      gst_percent: z.coerce.number().min(0).max(100).default(0),
      gst_number: safeText(32),
      is_enabled: boolish.default(false),
      instructions: safeText(500),
      order_ttl_minutes: z.coerce.number().int().min(5).max(1440).default(60),
    }),
  },
  history: {
    query: z.object({
      status: z.string().max(32).optional(),
      client_id: z.string().max(64).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  pending: {
    query: z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum(['VERIFICATION_PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('VERIFICATION_PENDING'),
      sort: z.enum(['newest', 'oldest', 'amount_high', 'amount_low']).default('oldest'),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Async handler wrapper — keeps every route free of try/catch boilerplate. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Actor context stamped onto every audit row. */
function actorOf(req) {
  return {
    id: req.user?.id || null,
    name: req.user?.name || null,
    role: req.user?.role || null,
    ip: req.ip || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

/**
 * Resolve the organization for this request, refusing to proceed without one.
 *
 * A tenant user with no organization would otherwise create orders stamped
 * with NULL, which no tenant filter matches — the row would exist and be
 * invisible to everyone, including the admin meant to verify it.
 */
function requireOrg(req) {
  const scope = tenantScope(req);
  if (!scope.orgId) {
    throw new upi.PaymentError('NO_TENANT', 'No studio context for this account', 403);
  }
  return scope.orgId;
}

/** Map a domain error onto an HTTP response; rethrow anything else. */
function sendPaymentError(res, err) {
  if (err instanceof upi.PaymentError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) },
    });
  }
  throw err;
}

/**
 * Load an order the caller is entitled to see.
 *
 * Members are restricted to their own member_id. A member asking for someone
 * else's order gets 404, not 403 — 403 would confirm the order exists.
 */
async function loadOrderForCaller(req, orderId) {
  const orgId = requireOrg(req);
  const params = [orderId, orgId];
  let clause = '';
  if (req.user.role === 'member') {
    if (!req.user.member_id) {
      throw new upi.PaymentError('NOT_FOUND', 'Payment not found', 404);
    }
    params.push(req.user.member_id);
    clause = ` AND o.client_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT ${upi.ORDER_COLUMNS}, c.name AS client_name, c.mobile AS client_mobile,
            c.email AS client_email
       FROM payment_orders o
       JOIN pt_clients c ON c.id = o.client_id
      WHERE o.id = $1 AND o.organization_id = $2${clause}`,
    params
  );
  if (!rows[0]) throw new upi.PaymentError('NOT_FOUND', 'Payment not found', 404);
  return rows[0];
}

/**
 * The member a non-admin caller is allowed to transact for.
 *
 * A member may only ever pay for themselves. Staff may pay on a member's
 * behalf (walk-in at the desk), which is why client_id is accepted at all.
 */
async function resolveTargetClient(req, requestedClientId, orgId) {
  const clientId = req.user.role === 'member' ? req.user.member_id : requestedClientId;
  if (!clientId) {
    throw new upi.PaymentError('NO_MEMBER', 'No member is linked to this account', 403);
  }
  const { rows } = await pool.query(
    `SELECT id, name, email, mobile, organization_id, pt_end_date
       FROM pt_clients WHERE id = $1 AND deleted_at IS NULL`,
    [clientId]
  );
  const member = rows[0];
  // 404 rather than 403 on a cross-tenant id, so the response cannot be used
  // to probe which member ids exist in other studios.
  if (!member || member.organization_id !== orgId) {
    throw new upi.PaymentError('NOT_FOUND', 'Member not found', 404);
  }
  return member;
}

/** Notify a user in-app. Never allowed to fail the surrounding operation. */
async function notify(userId, type, title, body, link) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,$2,$3,$4,$5)`,
      [userId, type, title, body, link || null]
    );
  } catch (err) {
    logger.warn({ err: err.message, userId, type }, 'upi: notification insert failed');
  }
}

/** The login attached to a member record, if there is one. */
async function userIdForClient(clientId) {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE member_id = $1 AND is_active = TRUE LIMIT 1`, [clientId]
  );
  return rows[0]?.id || null;
}

/** Studio admins and managers — the people who verify payments. */
async function adminUserIds(orgId) {
  const { rows } = await pool.query(
    `SELECT id FROM users
      WHERE organization_id = $1 AND is_active = TRUE AND role IN ('admin','manager')`,
    [orgId]
  );
  return rows.map((r) => r.id);
}

// ════════════════════════════════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════════════════════════════════

// GET /api/payments/upi/settings — what the payment page and the settings
// screen both read. Safe for any authenticated user in the studio: it exposes
// the studio's own public payee details and nothing else.
router.get('/settings', auth, wrap(async (req, res) => {
  const orgId = requireOrg(req);
  const settings = await upi.getSettings(orgId);
  res.json({ data: settings, configured: Boolean(settings), enabled: Boolean(settings?.is_enabled) });
}));

// PUT /api/payments/upi/settings — admin only.
router.put('/settings', auth, adminOnly, validate(schemas.settings), wrap(async (req, res) => {
  try {
    const orgId = requireOrg(req);
    const saved = await upi.upsertSettings(orgId, req.body);
    await logActivity(req, 'payment_settings.update', 'payment_settings', saved.id, {
      upi_id: saved.upi_id, is_enabled: saved.is_enabled, gst_percent: saved.gst_percent,
    });
    res.json({ data: saved });
  } catch (err) {
    sendPaymentError(res, err);
  }
}));

// ════════════════════════════════════════════════════════════════════════════
//  ORDERS
// ════════════════════════════════════════════════════════════════════════════

// POST /api/payments/upi/create
router.post('/create', auth, validate(schemas.createOrder), wrap(async (req, res) => {
  try {
    const orgId = requireOrg(req);
    const member = await resolveTargetClient(req, req.body.client_id, orgId);

    // Price resolution. When the order names a real plan, the STORED price is
    // authoritative and the submitted base_amount is discarded — otherwise a
    // member could POST a ₹1 base_amount for a ₹12,000 plan and the QR would
    // faithfully ask for ₹1. Ad-hoc packages (no plan_id) are staff-only for
    // the same reason.
    let plan = {
      plan_id: req.body.plan_id || null,
      plan_name: req.body.plan_name,
      duration_months: req.body.duration_months,
      base_amount: req.body.base_amount,
      notes: req.body.notes,
    };

    if (plan.plan_id) {
      const { rows } = await pool.query(
        `SELECT id, name, final_amount, duration FROM plans
          WHERE id = $1 AND deleted_at IS NULL AND is_active = TRUE`,
        [plan.plan_id]
      );
      if (!rows[0]) {
        return res.status(404).json({ error: { code: 'PLAN_NOT_FOUND', message: 'Plan not found' } });
      }
      plan = {
        ...plan,
        plan_name: rows[0].name,
        base_amount: Number(rows[0].final_amount),
        duration_months: DURATION_MONTHS[rows[0].duration] ?? plan.duration_months,
      };
    } else if (req.user.role === 'member') {
      return res.status(403).json({
        error: { code: 'PLAN_REQUIRED', message: 'Choose a membership plan to continue.' },
      });
    }

    const { order, reused } = await upi.createOrder(
      { orgId, client: member, plan, actor: actorOf(req) }
    );
    const view = await upi.buildPaymentView(order);

    res.status(reused ? 200 : 201).json({
      data: { order: { ...order, client_name: member.name }, payment: view, reused },
    });
  } catch (err) {
    sendPaymentError(res, err);
  }
}));

// GET /api/payments/upi/:id/status — the payment page's polling target and
// the member's detail view. Rebuilds the QR and intents on every read so a
// page left open overnight cannot show a stale amount.
router.get('/:id/status', auth, validate(schemas.idParam), wrap(async (req, res) => {
  try {
    const order = await loadOrderForCaller(req, req.params.id);
    const { rows: submissions } = await pool.query(
      `SELECT id, utr, screenshot_url, notes, status, submitted_at, verified_at,
              rejected_reason, rejected_note
         FROM payment_submissions WHERE payment_order_id = $1
        ORDER BY submitted_at DESC`,
      [order.id]
    );
    const { rows: activation } = await pool.query(
      `SELECT receipt_no, amount, utr, activated_from, activated_to, approved_at
         FROM membership_payments WHERE payment_order_id = $1`,
      [order.id]
    );

    // Only an order that can still be paid needs a QR; rendering one for an
    // approved order invites a second payment.
    const payable = upi.OPEN_ORDER_STATUSES.includes(order.status);
    const payment = payable ? await upi.buildPaymentView(order) : null;

    res.json({
      data: {
        order,
        payment,
        submissions,
        activation: activation[0] || null,
        reject_reasons: upi.REJECT_REASONS,
      },
    });
  } catch (err) {
    sendPaymentError(res, err);
  }
}));

// POST /api/payments/upi/:id/opened — records that a UPI app was launched.
// Best-effort telemetry that moves CREATED → PAYMENT_PENDING so the admin
// queue can tell "never tried" from "tried, no reference yet".
router.post('/:id/opened', auth, validate(schemas.idParam), wrap(async (req, res) => {
  try {
    const order = await loadOrderForCaller(req, req.params.id);
    const updated = await upi.markIntentOpened(order, actorOf(req));
    res.json({ data: { status: updated.status } });
  } catch (err) {
    sendPaymentError(res, err);
  }
}));

// ════════════════════════════════════════════════════════════════════════════
//  SCREENSHOT UPLOAD
// ════════════════════════════════════════════════════════════════════════════

// POST /api/payments/upi/:id/upload
//
// Returns a storage key, not a public URL, and the caller cannot choose it.
// The key is only accepted back by submit-utr if it matches what this endpoint
// issued for this order — see verifyScreenshotKey below — so a caller cannot
// attach an arbitrary object from storage to their submission.
router.post('/:id/upload', auth, validate(schemas.idParam), (req, res, next) => {
  screenshotUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    // multer's own errors are user-facing (file too large, wrong type) and
    // should read as 400s, not as a 500 from the generic handler.
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Screenshot must be 5 MB or smaller'
      : err.message || 'Upload failed';
    res.status(400).json({ error: { code: 'UPLOAD_REJECTED', message } });
  });
}, wrap(async (req, res) => {
  try {
    const order = await loadOrderForCaller(req, req.params.id);
    if (!req.file) {
      return res.status(400).json({ error: { code: 'NO_FILE', message: 'A file is required' } });
    }
    if (!upi.OPEN_ORDER_STATUSES.includes(order.status)) {
      return res.status(409).json({
        error: { code: 'ORDER_NOT_OPEN', message: 'This order is no longer accepting uploads.' },
      });
    }

    const detected = detectFileType(req.file.buffer);
    if (!detected) {
      return res.status(400).json({
        error: {
          code: 'UNSUPPORTED_FILE',
          message: 'File content does not match an allowed type (JPG, PNG or PDF)',
        },
      });
    }

    // Key shape is fixed server-side: <orderId>-<random>.<ext>. The order id
    // prefix is what lets submit-utr verify the key belongs to this order, and
    // the random tail stops one member guessing another's key.
    const filename = `${order.id}-${randomUUID()}.${detected.ext}`;
    const url = await saveFile('upi-proof', filename, req.file.buffer, detected.mime,
      { organizationId: req.user?.organization_id, uploadedBy: req.user?.id });

    await upi.audit(pool, {
      orgId: order.organization_id, orderId: order.id, action: 'SCREENSHOT_UPLOADED',
      detail: { mime: detected.mime, bytes: req.file.size }, actor: actorOf(req),
    });

    res.status(201).json({
      data: { screenshot_url: url, mime: detected.mime, bytes: req.file.size },
    });
  } catch (err) {
    sendPaymentError(res, err);
  }
}));

/**
 * Confirm a screenshot key was issued by /upload for THIS order.
 *
 * Without this the submission would accept any string as screenshot_url,
 * letting a caller point the admin's review at an unrelated object — or at an
 * off-site URL, turning the admin's browser into a request the attacker
 * controls. The key must be in our own namespace, and its filename must carry
 * this order's id.
 */
function verifyScreenshotKey(url, orderId) {
  if (!url) return null;
  const prefix = '/uploads/upi-proof/';
  if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
  const filename = url.slice(prefix.length);
  if (filename.includes('/') || filename.includes('..')) return null;
  if (!filename.startsWith(`${orderId}-`)) return null;
  return url;
}

// ════════════════════════════════════════════════════════════════════════════
//  UTR SUBMISSION
// ════════════════════════════════════════════════════════════════════════════

// POST /api/payments/upi/:id/submit-utr
router.post('/:id/submit-utr', auth, validate(schemas.submitUtr), wrap(async (req, res) => {
  try {
    const order = await loadOrderForCaller(req, req.params.id);

    // The client sends back whatever /upload returned. Anything else is
    // dropped silently rather than 400'd: a member who uploaded, lost the
    // response and retyped their UTR should still get their payment recorded,
    // just without the optional proof.
    let screenshot = null;
    if (req.body.screenshot_url) {
      const safeUrl = verifyScreenshotKey(req.body.screenshot_url, order.id);
      if (safeUrl) {
        const mime = ALLOWED_PROOF_MIME.includes(req.body.screenshot_mime)
          ? req.body.screenshot_mime : null;
        screenshot = { url: safeUrl, mime, bytes: null };
      } else {
        logger.warn(
          { orderId: order.id, userId: req.user.id },
          'upi: rejected a screenshot_url that this order did not issue'
        );
      }
    }

    const submission = await upi.submitUtr({
      order, utr: req.body.utr, screenshot, notes: req.body.notes, actor: actorOf(req),
    });

    // Tell the studio there is something to verify.
    const admins = await adminUserIds(order.organization_id);
    await Promise.all(admins.map((id) => notify(
      id, 'payment',
      'New payment waiting for verification',
      `${order.client_name} submitted UTR ${submission.utr} for ${order.plan_name}.`,
      '/finance/verify-payments'
    )));

    const memberUserId = await userIdForClient(order.client_id);
    await notify(
      memberUserId, 'payment', 'Payment submitted',
      'Your payment reference is with the studio for verification.',
      `/member/payments/${order.id}`
    );

    await logActivity(req, 'upi_payment.submit_utr', 'payment_orders', order.id, {
      utr: submission.utr, order_no: order.order_no,
    });

    res.status(201).json({ data: submission });
  } catch (err) {
    sendPaymentError(res, err);
  }
}));

// POST /api/payments/upi/:id/cancel — the member (or staff) withdraws.
router.post('/:id/cancel', auth, validate(schemas.idParam), wrap(async (req, res) => {
  try {
    const order = await loadOrderForCaller(req, req.params.id);
    const cancelled = await upi.cancel({
      orderId: order.id, orgId: order.organization_id, actor: actorOf(req),
    });
    await logActivity(req, 'upi_payment.cancel', 'payment_orders', order.id, {
      order_no: order.order_no,
    });
    res.json({ data: cancelled });
  } catch (err) {
    sendPaymentError(res, err);
  }
}));

// ════════════════════════════════════════════════════════════════════════════
//  HISTORY (member + staff)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/payments/upi/history
router.get('/history', auth, validate(schemas.history), wrap(async (req, res) => {
  const orgId = requireOrg(req);
  const conditions = ['o.organization_id = $1'];
  const params = [orgId];

  // A member sees only their own, whatever they ask for.
  if (req.user.role === 'member') {
    if (!req.user.member_id) return res.json({ data: [], total: 0 });
    params.push(req.user.member_id);
    conditions.push(`o.client_id = $${params.length}`);
  } else if (req.query.client_id) {
    params.push(req.query.client_id);
    conditions.push(`o.client_id = $${params.length}`);
  }
  if (req.query.status) {
    params.push(req.query.status);
    conditions.push(`o.status = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM payment_orders o ${where}`, params
  );

  params.push(req.query.limit, req.query.offset);
  const { rows } = await pool.query(
    `SELECT ${upi.ORDER_COLUMNS},
            c.name AS client_name,
            s.utr, s.status AS submission_status, s.submitted_at,
            s.rejected_reason, s.rejected_note, s.screenshot_url,
            mp.receipt_no, mp.activated_from, mp.activated_to
       FROM payment_orders o
       JOIN pt_clients c ON c.id = o.client_id
       LEFT JOIN LATERAL (
         SELECT * FROM payment_submissions ps
          WHERE ps.payment_order_id = o.id
          ORDER BY ps.submitted_at DESC LIMIT 1
       ) s ON TRUE
       LEFT JOIN membership_payments mp ON mp.payment_order_id = o.id
       ${where}
      ORDER BY o.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ data: rows, total: countRows[0].total });
}));

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN VERIFICATION QUEUE
// ════════════════════════════════════════════════════════════════════════════

// GET /api/payments/upi/pending — the queue plus the dashboard counters.
//
// The counters are computed in SQL rather than by paginating the list, so
// "Total Collection" is the real total and not the total of the first page.
router.get('/pending', auth, adminOnly, validate(schemas.pending), wrap(async (req, res) => {
  const orgId = requireOrg(req);

  const conditions = ['o.organization_id = $1'];
  const params = [orgId];

  if (req.query.status !== 'ALL') {
    params.push(req.query.status);
    conditions.push(`o.status = $${params.length}`);
  }
  if (req.query.q) {
    // Matched against member name, order number and UTR — the three things an
    // admin has in front of them when reconciling a bank statement.
    params.push(`%${req.query.q}%`);
    conditions.push(
      `(c.name ILIKE $${params.length} OR o.order_no ILIKE $${params.length} OR s.utr ILIKE $${params.length})`
    );
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const ORDER_BY = {
    oldest: 'o.created_at ASC',
    newest: 'o.created_at DESC',
    amount_high: 'o.total_amount DESC',
    amount_low: 'o.total_amount ASC',
  };

  const listParams = [...params, req.query.limit, req.query.offset];
  const { rows } = await pool.query(
    `SELECT ${upi.ORDER_COLUMNS},
            c.name AS client_name, c.mobile AS client_mobile, c.email AS client_email,
            c.photo_url AS client_photo_url,
            s.id AS submission_id, s.utr, s.screenshot_url, s.notes AS submission_notes,
            s.submitted_at, s.status AS submission_status,
            s.rejected_reason, s.rejected_note
       FROM payment_orders o
       JOIN pt_clients c ON c.id = o.client_id
       LEFT JOIN LATERAL (
         SELECT * FROM payment_submissions ps
          WHERE ps.payment_order_id = o.id
          ORDER BY ps.submitted_at DESC LIMIT 1
       ) s ON TRUE
       ${where}
      ORDER BY ${ORDER_BY[req.query.sort]}
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total
       FROM payment_orders o
       JOIN pt_clients c ON c.id = o.client_id
       LEFT JOIN LATERAL (
         SELECT * FROM payment_submissions ps
          WHERE ps.payment_order_id = o.id
          ORDER BY ps.submitted_at DESC LIMIT 1
       ) s ON TRUE
       ${where}`,
    params
  );

  // Counters. "Today" is the studio's calendar day in the database's timezone,
  // matching how every other report in this app buckets a day.
  const { rows: statRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE o.status = 'VERIFICATION_PENDING')::int         AS pending_count,
       COALESCE(SUM(o.total_amount) FILTER (WHERE o.status = 'VERIFICATION_PENDING'), 0) AS pending_amount,
       COUNT(*) FILTER (WHERE mp.approved_at::date = CURRENT_DATE)::int       AS approved_today,
       COALESCE(SUM(mp.amount) FILTER (WHERE mp.approved_at::date = CURRENT_DATE), 0)    AS approved_today_amount,
       COALESCE(SUM(mp.amount), 0)                                            AS total_collected
     FROM payment_orders o
     LEFT JOIN membership_payments mp ON mp.payment_order_id = o.id
     WHERE o.organization_id = $1`,
    [orgId]
  );

  const { rows: rejectRows } = await pool.query(
    `SELECT COUNT(*)::int AS rejected_today
       FROM payment_submissions
      WHERE organization_id = $1 AND status = 'REJECTED' AND verified_at::date = CURRENT_DATE`,
    [orgId]
  );

  res.json({
    data: rows,
    total: countRows[0].total,
    stats: { ...statRows[0], ...rejectRows[0] },
    reject_reasons: upi.REJECT_REASONS,
  });
}));

// GET /api/payments/upi/:id/audit — the trail for one payment (admin only).
router.get('/:id/audit', auth, adminOnly, validate(schemas.idParam), wrap(async (req, res) => {
  const orgId = requireOrg(req);
  const { rows } = await pool.query(
    `SELECT action, from_status, to_status, detail, actor_name, actor_role, created_at
       FROM payment_audit_logs
      WHERE payment_order_id = $1 AND organization_id = $2
      ORDER BY created_at ASC`,
    [req.params.id, orgId]
  );
  res.json({ data: rows });
}));

// POST /api/payments/upi/:id/approve — admin only.
router.post('/:id/approve', auth, adminOnly, validate(schemas.idParam), wrap(async (req, res) => {
  try {
    const orgId = requireOrg(req);
    const result = await upi.approve({ orderId: req.params.id, orgId, actor: actorOf(req) });

    const memberUserId = await userIdForClient(result.member.id);
    await notify(
      memberUserId, 'payment', 'Payment approved',
      `Your ${result.order.plan_name} membership is active until ${result.activation.activated_to}.`,
      `/member/payments/${result.order.id}`
    );

    await logActivity(req, 'upi_payment.approve', 'payment_orders', result.order.id, {
      order_no: result.order.order_no,
      utr: result.submission.utr,
      amount: result.order.total_amount,
      receipt_no: result.activation.receipt_no,
      activated_to: result.activation.activated_to,
    });

    res.json({ data: { order: result.order, activation: result.activation } });
  } catch (err) {
    sendPaymentError(res, err);
  }
}));

// POST /api/payments/upi/:id/reject — admin only.
router.post('/:id/reject', auth, adminOnly, validate(schemas.reject), wrap(async (req, res) => {
  try {
    const orgId = requireOrg(req);
    const result = await upi.reject({
      orderId: req.params.id, orgId,
      reason: req.body.reason, note: req.body.note, actor: actorOf(req),
    });

    const { rows } = await pool.query(
      'SELECT client_id, plan_name FROM payment_orders WHERE id = $1', [req.params.id]
    );
    const memberUserId = await userIdForClient(rows[0]?.client_id);
    await notify(
      memberUserId, 'payment', 'Payment could not be verified',
      `${upi.REJECT_REASONS[result.reason]}${result.note ? ` — ${result.note}` : ''} You can submit a new reference.`,
      `/member/payments/${req.params.id}`
    );

    await logActivity(req, 'upi_payment.reject', 'payment_orders', req.params.id, {
      reason: result.reason, note: result.note,
    });

    res.json({ data: result });
  } catch (err) {
    sendPaymentError(res, err);
  }
}));

// POST /api/payments/upi/:id/request-correction — a rejection with a softer
// framing. Same transition, so the member can resubmit either way; the audit
// action differs so the trail records what the admin actually meant.
router.post('/:id/request-correction', auth, adminOnly, validate(schemas.reject),
  wrap(async (req, res) => {
    try {
      const orgId = requireOrg(req);
      const result = await upi.reject({
        orderId: req.params.id, orgId, reason: req.body.reason, note: req.body.note,
        actor: actorOf(req), correction: true,
      });
      const { rows } = await pool.query(
        'SELECT client_id FROM payment_orders WHERE id = $1', [req.params.id]
      );
      const memberUserId = await userIdForClient(rows[0]?.client_id);
      await notify(
        memberUserId, 'payment', 'Please check your payment reference',
        `${result.note || upi.REJECT_REASONS[result.reason]} Submit the corrected reference to continue.`,
        `/member/payments/${req.params.id}`
      );
      res.json({ data: result });
    } catch (err) {
      sendPaymentError(res, err);
    }
  }));

// ════════════════════════════════════════════════════════════════════════════
//  RECEIPT
// ════════════════════════════════════════════════════════════════════════════

// GET /api/payments/upi/:id/receipt — PDF, rendered on demand.
router.get('/:id/receipt', auth, validate(schemas.idParam), wrap(async (req, res) => {
  try {
    const order = await loadOrderForCaller(req, req.params.id);

    const { rows: activationRows } = await pool.query(
      `SELECT * FROM membership_payments WHERE payment_order_id = $1`, [order.id]
    );
    const activation = activationRows[0];
    if (!activation) {
      return res.status(409).json({
        error: { code: 'NOT_APPROVED', message: 'A receipt is available once the payment is approved.' },
      });
    }

    const { rows: submissionRows } = await pool.query(
      `SELECT * FROM payment_submissions WHERE id = $1`, [activation.submission_id]
    );
    const { rows: memberRows } = await pool.query(
      `SELECT id, name, email, mobile FROM pt_clients WHERE id = $1`, [order.client_id]
    );
    const { rows: orgRows } = await pool.query(
      `SELECT name FROM organizations WHERE id = $1`, [order.organization_id]
    );

    const buffer = await generateUpiReceiptPdf({
      order,
      submission: submissionRows[0],
      activation,
      member: memberRows[0],
      organization: orgRows[0],
    });

    // A receipt names an individual and the amount they paid — it must never
    // land in a shared or CDN cache.
    res.set('Cache-Control', 'private, no-store');
    res.type('application/pdf');
    res.set('Content-Disposition', `inline; filename="receipt-${activation.receipt_no}.pdf"`);
    res.send(buffer);
  } catch (err) {
    sendPaymentError(res, err);
  }
}));

module.exports = router;
