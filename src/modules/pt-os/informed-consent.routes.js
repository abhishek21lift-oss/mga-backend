// src/modules/pt-os/informed-consent.routes.js
// Personal Training Informed Consent module.
// Mounted at /api/pt-os, so final paths are /api/pt-os/informed-consent/...
//
// Follows the same conventions as parq.routes.js: a shared wrap() for
// async error handling, auth + requireRole('admin','manager','trainer')
// on every write (this app is staff-operated — consent is signed in
// person on a staff device during onboarding, there is no separate
// PT-client login), and logActivity() for the audit trail.
const router = require('express').Router();
const multer = require('multer');
const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const { logActivity } = require('../../lib/activityLog');
const { generateInformedConsentPdf } = require('../../lib/informedConsentPdf');
const { saveFile } = require('../../lib/fileStorage');
const { tenantScope, orgIdOf } = require('../../lib/tenant-db');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Section 6/7/8 acknowledgements (Agreement step) — all 3 must be true
// before a signature can be captured. The Section 2/4 risk-acknowledgement
// items were dropped along with the Risks & Responsibilities wizard step.
const ACK_KEYS = [
  'understands_confidentiality', 'voluntary_participation', 'final_declaration',
];


// ─── Schemas ────────────────────────────────────────────────

const createSchema = {
  body: z.object({
    client_id: z.string(),
    // All optional — server auto-fills from the live pt_clients row when
    // omitted (Section: "Client Information ... Auto-fill from client
    // profile"). Callers may still override (e.g. a corrected DOB).
    full_name: z.string().max(255).optional().nullable(),
    gender: z.string().max(20).optional().nullable(),
    dob: z.string().optional().nullable(),
    mobile: z.string().max(20).optional().nullable(),
    email: z.string().email().max(255).optional().nullable(),
    emergency_contact: z.string().max(255).optional().nullable(),
    emergency_phone: z.string().max(20).optional().nullable(),
    address: z.string().max(1000).optional().nullable(),
    occupation: z.string().max(255).optional().nullable(),
  }),
};

const updateSchema = {
  body: z.object({
    full_name: z.string().max(255).optional(),
    gender: z.string().max(20).optional().nullable(),
    dob: z.string().optional().nullable(),
    mobile: z.string().max(20).optional().nullable(),
    email: z.string().email().max(255).optional().nullable(),
    emergency_contact: z.string().max(255).optional().nullable(),
    emergency_phone: z.string().max(20).optional().nullable(),
    address: z.string().max(1000).optional().nullable(),
    occupation: z.string().max(255).optional().nullable(),
    acknowledgements: z.record(z.string(), z.boolean()).optional(),
    physician_advised_against: z.boolean().optional().nullable(),
    physician_name: z.string().max(255).optional().nullable(),
    hospital: z.string().max(255).optional().nullable(),
    medical_condition: z.string().max(1000).optional().nullable(),
    // Exercise Programme Consent — a distinct sub-section with its own
    // text/checkbox/date/signature (see migration 067).
    exercise_consent_text: z.string().max(8000).optional().nullable(),
    exercise_consent_checked: z.boolean().optional(),
    exercise_consent_date: z.string().optional().nullable(),
    exercise_consent_signature: z.string().optional().nullable(),
  }),
};

const signSchema = {
  body: z.object({
    signer: z.enum(['client', 'trainer', 'witness']),
    signature: z.string().min(1),
    witness_name: z.string().max(255).optional().nullable(),
  }),
};

const SNAPSHOT_FIELDS = [
  'full_name', 'gender', 'dob', 'mobile', 'email',
  'emergency_contact', 'emergency_phone', 'address', 'occupation',
];

// ─── Helpers ────────────────────────────────────────────────

// Tenant scope: only snapshot a client in the caller's own org, otherwise a
// consent create with a foreign client_id would copy that client's PII into a
// new record owned by the caller's org (cross-tenant PII exfiltration).
async function fetchClientSnapshot(clientId, req) {
  const scope = tenantScope(req);
  const params = [clientId];
  let orgClause = '';
  if (scope.applyFilter) { params.push(scope.orgId); orgClause = ' AND organization_id = $2'; }
  const { rows } = await pool.query(
    `SELECT name AS full_name, gender, dob, mobile, email, address, occupation,
            emergency_contact, emergency_phone, trainer_id
       FROM pt_clients WHERE id = $1${orgClause}`,
    params
  );
  return rows[0] || null;
}

// ─── Informed Consents ──────────────────────────────────────

// GET /informed-consent?client_id= — active record first, then history.
router.get('/informed-consent', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = [];
  const params = [];
  const scope = tenantScope(req);
  if (scope.applyFilter) { params.push(scope.orgId); where.push(`organization_id = $${params.length}`); }
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_informed_consents ${whereSql} ORDER BY created_at DESC`, params
  );
  res.json({ data: rows });
}));

// GET /informed-consent/:id
router.get('/informed-consent/:id', auth, wrap(async (req, res) => {
  const scope = tenantScope(req);
  const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_informed_consents WHERE id = $1${guard}`,
    scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ data: rows[0] });
}));

// GET /informed-consent/:id/activity — reuses the generic activity_log
// table (see src/lib/activityLog.js); scoped by entity rather than by
// user, unlike GET /profile/activity.
router.get('/informed-consent/:id/activity', auth, wrap(async (req, res) => {
  // Gate on the parent consent's org — activity_log has no org column.
  const scope = tenantScope(req);
  const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: owner } = await pool.query(
    `SELECT id FROM pt_informed_consents WHERE id = $1${guard}`,
    scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
  );
  if (!owner[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const { rows } = await pool.query(
    `SELECT id, user_id, user_name, action, new_data, ip_address, created_at
       FROM activity_log
      WHERE entity_type = 'pt_informed_consents' AND entity_id = $1
      ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json({ data: rows });
}));

// POST /informed-consent — creates a new draft, auto-filling the client
// snapshot from pt_clients for any field not explicitly provided.
router.post('/informed-consent', auth, requireRole('admin', 'manager', 'trainer'), validate(createSchema), wrap(async (req, res) => {
  const b = req.body;
  const snapshot = await fetchClientSnapshot(b.client_id, req);
  if (!snapshot) return res.status(404).json({ error: { code: 'CLIENT_NOT_FOUND' } });

  const values = {};
  for (const key of SNAPSHOT_FIELDS) {
    values[key] = b[key] !== undefined && b[key] !== null ? b[key] : (snapshot[key] ?? null);
  }
  if (!values.full_name) {
    return res.status(400).json({ error: { code: 'FULL_NAME_REQUIRED' } });
  }

  const { rows } = await pool.query(
    `INSERT INTO pt_informed_consents (
       client_id, trainer_id, status,
       full_name, gender, dob, mobile, email, emergency_contact, emergency_phone, address, occupation,
       created_by, organization_id
     ) VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      b.client_id, snapshot.trainer_id || null,
      values.full_name, values.gender, values.dob, values.mobile, values.email,
      values.emergency_contact, values.emergency_phone, values.address, values.occupation,
      req.user.id, orgIdOf(req),
    ]
  );
  const record = rows[0];

  await logActivity(req, 'informed_consent.create', 'pt_informed_consents', record.id, { client_id: b.client_id });
  res.status(201).json({ data: record });
}));

// PATCH /informed-consent/:id
// A draft is edited in place. A completed record is never overwritten —
// editing it archives the current row and creates a new draft version
// carrying the patched fields forward, per the module's versioning rule.
router.patch('/informed-consent/:id', auth, requireRole('admin', 'manager', 'trainer'), validate(updateSchema), wrap(async (req, res) => {
  const { id } = req.params;
  const b = req.body;

  const editable = [
    'full_name', 'gender', 'dob', 'mobile', 'email', 'emergency_contact', 'emergency_phone',
    'address', 'occupation', 'acknowledgements', 'physician_advised_against',
    'physician_name', 'hospital', 'medical_condition',
    'exercise_consent_text', 'exercise_consent_checked', 'exercise_consent_date', 'exercise_consent_signature',
  ];
  const jsonFields = new Set(['acknowledgements']);

  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const scope = tenantScope(req);
    const upGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
    const { rows: existingRows } = await tx.query(
      `SELECT * FROM pt_informed_consents WHERE id = $1${upGuard} FOR UPDATE`,
      scope.applyFilter ? [id, scope.orgId] : [id]
    );
    const existing = existingRows[0];
    if (!existing) { await tx.query('ROLLBACK'); return res.status(404).json({ error: { code: 'NOT_FOUND' } }); }
    if (['revoked', 'archived', 'expired'].includes(existing.status)) {
      await tx.query('ROLLBACK');
      return res.status(409).json({ error: { code: 'NOT_EDITABLE', status: existing.status } });
    }

    let targetId = id;
    if (existing.status === 'completed') {
      await tx.query(
        `UPDATE pt_informed_consents SET status = 'archived', updated_at = NOW() WHERE id = $1`, [id]
      );
      const { rows: newRows } = await tx.query(
        `INSERT INTO pt_informed_consents (
           client_id, trainer_id, version, previous_version_id, status,
           full_name, gender, dob, mobile, email, emergency_contact, emergency_phone, address, occupation,
           acknowledgements, physician_advised_against, physician_name, hospital, medical_condition,
           created_by, organization_id
         )
         SELECT client_id, trainer_id, version + 1, id, 'draft',
                full_name, gender, dob, mobile, email, emergency_contact, emergency_phone, address, occupation,
                acknowledgements, physician_advised_against, physician_name, hospital, medical_condition,
                $2, organization_id
           FROM pt_informed_consents WHERE id = $1
         RETURNING id`,
        [id, req.user.id]
      );
      targetId = newRows[0].id;
    }

    const sets = [];
    const params = [targetId];
    for (const key of editable) {
      if (b[key] !== undefined) {
        const isJson = jsonFields.has(key) && b[key] !== null;
        params.push(isJson ? JSON.stringify(b[key]) : b[key]);
        sets.push(`${key} = $${params.length}${isJson ? '::jsonb' : ''}`);
      }
    }

    // Exercise Programme Consent completes in this same PATCH (it's not
    // routed through /sign — that endpoint is for the overall document's
    // client/trainer/witness roles). Stamp the timestamp server-side,
    // never trust a client-supplied one, the moment both the checkbox and
    // signature are present.
    if (b.exercise_consent_checked === true && b.exercise_consent_signature) {
      sets.push('exercise_consent_signed_at = NOW()');
    }

    if (sets.length) {
      sets.push('updated_at = NOW()');
      await tx.query(`UPDATE pt_informed_consents SET ${sets.join(', ')} WHERE id = $1`, params);
    }

    await tx.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM pt_informed_consents WHERE id = $1', [targetId]);
    if (targetId !== id) {
      await logActivity(req, 'informed_consent.new_version', 'pt_informed_consents', targetId, { previous_version_id: id });
    }
    res.json({ data: rows[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}));

// POST /informed-consent/:id/sign
// Captures one signature (client/trainer/witness). Once both the client
// and trainer have signed and every acknowledgement is true, the record
// is finalized: status -> completed, capture metadata recorded, PDF
// generated.
router.post('/informed-consent/:id/sign', auth, requireRole('admin', 'manager', 'trainer'), validate(signSchema), wrap(async (req, res) => {
  const { id } = req.params;
  const scope = tenantScope(req);
  const signGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_informed_consents WHERE id = $1${signGuard}`,
    scope.applyFilter ? [id, scope.orgId] : [id]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  if (['completed', 'revoked', 'archived', 'expired'].includes(existing.status)) {
    return res.status(409).json({ error: { code: 'NOT_SIGNABLE', status: existing.status } });
  }

  const acks = existing.acknowledgements || {};
  const allAcked = ACK_KEYS.every((k) => acks[k] === true);
  if (!allAcked) {
    return res.status(400).json({ error: { code: 'ACKNOWLEDGEMENTS_INCOMPLETE' } });
  }

  const { signer, signature, witness_name } = req.body;
  const col = signer === 'client' ? 'client_signature' : signer === 'trainer' ? 'trainer_signature' : 'witness_signature';
  const atCol = signer === 'client' ? 'client_signed_at' : signer === 'trainer' ? 'trainer_signed_at' : 'witness_signed_at';

  const sets = [`${col} = $2`, `${atCol} = NOW()`, 'updated_at = NOW()'];
  const params = [id, signature];
  if (signer === 'witness' && witness_name) { params.push(witness_name); sets.push(`witness_name = $${params.length}`); }

  const { rows } = await pool.query(
    `UPDATE pt_informed_consents SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
  );
  let record = rows[0];

  await logActivity(req, `informed_consent.sign.${signer}`, 'pt_informed_consents', id, {});

  const bothSigned = Boolean(record.client_signature) && Boolean(record.trainer_signature);
  if (bothSigned && record.status !== 'completed') {
    const ua = String(req.headers['user-agent'] || '');
    const device = /Mobile|Android|iPhone/i.test(ua) ? 'mobile' : /iPad|Tablet/i.test(ua) ? 'tablet' : 'desktop';
    const browser = /Chrome/i.test(ua) ? 'Chrome'
      : /Firefox/i.test(ua) ? 'Firefox'
      : /Safari/i.test(ua) ? 'Safari'
      : /Edge/i.test(ua) ? 'Edge'
      : 'Browser';

    const { rows: completedRows } = await pool.query(
      `UPDATE pt_informed_consents
          SET status = 'completed', completed_at = NOW(), ip_address = $2, device = $3, browser = $4, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, req.ip || null, device, browser]
    );
    record = completedRows[0];

    // PDF generation failure shouldn't fail the signed record itself — it's
    // already durably stored and the PDF can be regenerated later.
    try {
      const pdfUrl = await generateInformedConsentPdf(record);
      const { rows: withPdf } = await pool.query(
        'UPDATE pt_informed_consents SET pdf_url = $1 WHERE id = $2 RETURNING *', [pdfUrl, id]
      );
      record = withPdf[0];
    } catch (err) {
      logger.error({ err: err.message, id }, 'informed consent PDF generation failed');
    }

    await logActivity(req, 'informed_consent.completed', 'pt_informed_consents', id, {});
  }

  res.json({ data: record });
}));

// POST /informed-consent/:id/revoke
router.post('/informed-consent/:id/revoke', auth, requireRole('admin', 'manager'), wrap(async (req, res) => {
  const scope = tenantScope(req);
  const rvGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows } = await pool.query(
    `UPDATE pt_informed_consents SET status = 'revoked', updated_at = NOW() WHERE id = $1${rvGuard} RETURNING *`,
    scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  await logActivity(req, 'informed_consent.revoke', 'pt_informed_consents', req.params.id, {});
  res.json({ data: rows[0] });
}));

// ─── Medical Clearance Upload ───────────────────────────────
// Same multer + memoryStorage + magic-byte-sniff pattern as parq.routes.js
// (MIME header alone can be spoofed).

const IC_MAX_UPLOAD_BYTES = parseInt(process.env.PARQ_MAX_UPLOAD_BYTES, 10) || 10 * 1024 * 1024;
const clearanceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IC_MAX_UPLOAD_BYTES },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g)$|^application\/pdf$/i.test(file.mimetype || '')) {
      return cb(new Error('Only PNG, JPG, or PDF files are allowed'));
    }
    cb(null, true);
  },
});

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

// POST /informed-consent/:id/medical-clearance
router.post('/informed-consent/:id/medical-clearance', auth, requireRole('admin', 'manager', 'trainer'), clearanceUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: { code: 'FILE_REQUIRED' } });

  const { id } = req.params;
  const scope = tenantScope(req);
  const mcGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: existingRows } = await pool.query(
    `SELECT id FROM pt_informed_consents WHERE id = $1${mcGuard}`,
    scope.applyFilter ? [id, scope.orgId] : [id]
  );
  if (!existingRows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const detected = detectFileType(req.file.buffer);
  if (!detected) {
    return res.status(400).json({ error: { code: 'INVALID_FILE_TYPE' } });
  }

  const filename = `${id}-${Date.now()}.${detected.ext}`;
  const fileUrl = await saveFile('informed-consent', filename, req.file.buffer, detected.mime,
    { organizationId: req.user?.organization_id, uploadedBy: req.user?.id });

  const { rows } = await pool.query(
    `UPDATE pt_informed_consents SET medical_clearance_file_url = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [fileUrl, id]
  );
  await logActivity(req, 'informed_consent.clearance_upload', 'pt_informed_consents', id, {});
  res.status(201).json({ data: rows[0] });
}));

module.exports = router;
