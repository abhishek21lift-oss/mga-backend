// src/modules/pt-os/parq.routes.js
// PAR-Q + Health Screening + Medical Clearance + Digital Consent module.
// Mounted at /api/pt-os, so final paths are /api/pt-os/parq/...
//
// Conventions follow src/modules/progress/progress.routes.js: zod validation
// with a local numOpt() helper, a server-side "compute analysis on write"
// function re-run on both POST and PATCH so derived columns never drift
// from raw inputs, and a shared wrap() for async error handling.
const router = require('express').Router();
const multer = require('multer');
const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const { logActivity } = require('../../lib/activityLog');
const { generateConsentPdf } = require('../../lib/parqPdf');
const { saveFile } = require('../../lib/fileStorage');
const { tenantScope, orgIdOf } = require('../../lib/tenant-db');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const numOpt = () => z.coerce.number().optional().nullable();

// ─── Analysis helpers (shared by POST + PATCH so derived columns never drift) ───

// Rule: count answer === 'yes' across the 10 fixed PAR-Q questions.
// 0 yes = low, 1-2 = medium, 3+ = high. Never trust a client-supplied risk
// level — a malicious/buggy client could self-report LOW risk to bypass
// the workout-assignment gate, so this is always recomputed server-side.
function computeParqAnalysis(parqAnswers) {
  const answers = Array.isArray(parqAnswers) ? parqAnswers : [];
  const yesCount = answers.filter((a) => a && a.answer === 'yes').length;
  let riskLevel;
  let riskMessage;
  if (yesCount === 0) {
    riskLevel = 'low';
    riskMessage = 'Approved for Exercise';
  } else if (yesCount <= 2) {
    riskLevel = 'medium';
    riskMessage = 'Trainer Review Required';
  } else {
    riskLevel = 'high';
    riskMessage = 'Medical Clearance Required — Workout Assignment Disabled';
  }
  return { yesCount, riskLevel, riskMessage };
}

function calcBmi(weightKg, heightCm) {
  const w = Number(weightKg);
  const h = Number(heightCm);
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return null;
  const heightM = h / 100;
  return Math.round((w / (heightM * heightM)) * 10) / 10;
}

// Authoritative gate-status recompute — callable from both the form routes
// (POST/PATCH /forms) and the medical-clearance routes, since approving a
// clearance later must flip a previously-blocked form to cleared.
async function recomputeGateStatus(pool, formId) {
  const { rows: formRows } = await pool.query(
    'SELECT risk_level FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL', [formId]
  );
  const form = formRows[0];
  if (!form) return null;

  let gateStatus;
  if (form.risk_level === 'high') {
    const { rows: clearanceRows } = await pool.query(
      `SELECT 1 FROM pt_medical_clearances
        WHERE parq_form_id = $1 AND approval_status = 'approved'
          AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
        LIMIT 1`,
      [formId]
    );
    gateStatus = clearanceRows.length ? 'cleared' : 'blocked';
  } else {
    gateStatus = 'cleared';
  }

  const { rows } = await pool.query(
    `UPDATE pt_parq_forms SET workout_gate_status = $1, updated_at = NOW()
      WHERE id = $2 RETURNING workout_gate_status, risk_level`,
    [gateStatus, formId]
  );
  return rows[0];
}

// Delete + reinsert is the simplest correct approach for this small child
// collection (a handful of rows per form). Safe to call with an empty/no
// prior rows too, so POST reuses it instead of duplicating the INSERT loop.
async function replaceFamilyHistory(tx, formId, list) {
  await tx.query('DELETE FROM pt_family_medical_history WHERE parq_form_id = $1', [formId]);
  for (const fh of (list || [])) {
    await tx.query(
      `INSERT INTO pt_family_medical_history (
         parq_form_id, relation, heart_disease, diabetes, stroke, hypertension, cancer,
         hyperlipidemia, kidney_disease, sudden_death, age_of_onset, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        formId, fh.relation,
        Boolean(fh.heart_disease), Boolean(fh.diabetes), Boolean(fh.stroke), Boolean(fh.hypertension),
        Boolean(fh.cancer), Boolean(fh.hyperlipidemia), Boolean(fh.kidney_disease), Boolean(fh.sudden_death),
        fh.age_of_onset ?? null, fh.notes || null,
      ]
    );
  }
}

// ─── Schemas ────────────────────────────────────────────────

const parqAnswerSchema = z.object({
  question_id: z.union([z.string(), z.number()]),
  // Draft-friendly: the form is created as a draft on step 1, before the user
  // reaches the PAR-Q step, so an answer may still be blank. '' / null means
  // "not yet answered". computeParqAnalysis() ignores anything that isn't
  // 'yes', and the client enforces all-answered before submit.
  answer: z.enum(['yes', 'no']).or(z.literal('')).optional().nullable(),
  explanation: z.string().max(1000).optional().nullable(),
  diagnosis_date: z.string().optional().nullable(),
  treatment: z.string().max(500).optional().nullable(),
  doctor_name: z.string().max(255).optional().nullable(),
  hospital: z.string().max(255).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

const familyHistorySchema = z.object({
  relation: z.enum(['father', 'mother', 'brother', 'sister', 'grandparent']),
  heart_disease: z.boolean().optional(),
  diabetes: z.boolean().optional(),
  stroke: z.boolean().optional(),
  hypertension: z.boolean().optional(),
  cancer: z.boolean().optional(),
  hyperlipidemia: z.boolean().optional(),
  kidney_disease: z.boolean().optional(),
  sudden_death: z.boolean().optional(),
  age_of_onset: numOpt(),
  notes: z.string().max(1000).optional().nullable(),
});

const parqFormCreateSchema = {
  body: z.object({
    client_id: z.string(),
    assessment_date: z.string().optional().nullable(),

    // Step 1: Client snapshot
    full_name: z.string().min(1).max(255),
    gender: z.string().max(20).optional().nullable(),
    dob: z.string().optional().nullable(),
    mobile: z.string().max(20).optional().nullable(),
    email: z.string().email().max(255).optional().nullable(),
    emergency_contact: z.string().max(255).optional().nullable(),
    emergency_phone: z.string().max(20).optional().nullable(),
    blood_group: z.string().max(10).optional().nullable(),
    height_cm: numOpt(), weight_kg: numOpt(), bmi: numOpt(),
    trainer_name: z.string().max(255).optional().nullable(),

    // Step 2: Current Health (heterogeneous toggle+expand fields)
    current_health: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 3: Past Medical History
    past_history: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 4: Family Medical History
    family_history: z.array(familyHistorySchema).optional().nullable(),

    // Step 5: PAR-Q — up to the 10 fixed questions; a draft created on step 1
    // may carry blank/unanswered entries (see parqAnswerSchema).
    parq_answers: z.array(parqAnswerSchema).max(10).optional().default([]),

    // Step 7: Trainer Notes
    trainer_notes: z.record(z.string(), z.unknown()).optional().nullable(),

    status: z.enum(['draft', 'submitted', 'reviewed']).optional(),
  }),
};

const clearanceCreateSchema = {
  body: z.object({
    doctor_name: z.string().max(255).optional().nullable(),
    hospital: z.string().max(255).optional().nullable(),
    clearance_date: z.string().optional().nullable(),
    certificate_url: z.string().max(1000).optional().nullable(),
    doctor_contact: z.string().max(50).optional().nullable(),
    expiry_date: z.string().optional().nullable(),
    approval_status: z.enum(['approved', 'rejected', 'pending']).optional(),
  }),
};

// All 7 keys from the migration's pt_consent_records.consent_checkboxes comment.
const CONSENT_KEYS = [
  'info_true', 'understands_risk', 'will_inform_changes', 'understands_incorrect_info_risk',
  'voluntary_participation', 'consents_emergency_care', 'agrees_data_storage',
];

const consentCreateSchema = {
  body: z.object({
    consent_checkboxes: z.record(z.string(), z.boolean()),
    client_signature: z.string().min(1).optional().nullable(),
    trainer_signature: z.string().min(1).optional().nullable(),
    location: z.string().max(500).optional().nullable(),
  }),
};

// ─── PAR-Q Forms ────────────────────────────────────────────

// GET /parq/forms?client_id=
router.get('/parq/forms', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = ['deleted_at IS NULL'];
  const params = [];
  const scope = tenantScope(req);
  if (scope.applyFilter) { params.push(scope.orgId); where.push(`organization_id = $${params.length}`); }
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM pt_parq_forms WHERE ${where.join(' AND ')} ORDER BY assessment_date DESC`, params
  );
  res.json({ data: rows });
}));

// GET /parq/forms/:id — form + family history + clearance + consent + documents.
// Parallel queries rather than one giant JOIN (child collections have very
// different cardinalities/shapes, so a JOIN would just require de-duplicating
// the parent row in application code anyway).
//
// Clearance and consent are returned SINGULAR — `medical_clearance` and
// `consent`, not the underlying row arrays. That is the shape the client's
// ParqFormDetail contract declares, and the edit screen reads
// `row.medical_clearance?.id` to decide update-vs-create. Emitting the arrays
// here (as this route used to) left both fields undefined on the client: the
// clearance and consent sections silently rendered blank for forms that had
// them, and every re-save took the create path and wrote a duplicate
// pt_medical_clearances row. Both queries order by created_at DESC, so row 0
// is the current record; a form only ever has one live clearance/consent.
router.get('/parq/forms/:id', auth, wrap(async (req, res) => {
  const { id } = req.params;
  const scope = tenantScope(req);
  const formGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const formParams = scope.applyFilter ? [id, scope.orgId] : [id];
  const [formRes, familyRes, clearanceRes, consentRes, docsRes] = await Promise.all([
    pool.query(`SELECT * FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${formGuard}`, formParams),
    pool.query('SELECT * FROM pt_family_medical_history WHERE parq_form_id = $1 ORDER BY created_at', [id]),
    pool.query('SELECT * FROM pt_medical_clearances WHERE parq_form_id = $1 ORDER BY created_at DESC', [id]),
    pool.query('SELECT * FROM pt_consent_records WHERE parq_form_id = $1 ORDER BY created_at DESC', [id]),
    pool.query('SELECT * FROM pt_parq_documents WHERE parq_form_id = $1 ORDER BY created_at DESC', [id]),
  ]);
  const form = formRes.rows[0];
  if (!form) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  res.json({
    data: {
      ...form,
      family_history: familyRes.rows,
      medical_clearance: clearanceRes.rows[0] ?? null,
      consent: consentRes.rows[0] ?? null,
      documents: docsRes.rows,
    },
  });
}));

// GET /parq/forms/:id/gate-status — lightweight pre-check for the frontend
// before showing the workout Assign button.
router.get('/parq/forms/:id/gate-status', auth, wrap(async (req, res) => {
  const scope = tenantScope(req);
  const gsGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows } = await pool.query(
    `SELECT workout_gate_status, risk_level FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${gsGuard}`,
    scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ data: rows[0] });
}));

// POST /parq/forms
router.post('/parq/forms', auth, requireRole('admin', 'manager', 'trainer'), validate(parqFormCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  const analysis = computeParqAnalysis(b.parq_answers);
  const gateStatus = analysis.riskLevel === 'high' ? 'blocked' : 'cleared';
  const bmi = b.bmi ?? calcBmi(b.weight_kg, b.height_cm);

  const tx = await pool.connect();
  let formId;
  try {
    await tx.query('BEGIN');
    const { rows } = await tx.query(
      `INSERT INTO pt_parq_forms (
         client_id, assessment_date, assessment_number,
         full_name, gender, dob, mobile, email, emergency_contact, emergency_phone, blood_group,
         height_cm, weight_kg, bmi, trainer_name,
         current_health, past_history,
         parq_answers, parq_yes_count,
         risk_level, risk_message,
         trainer_notes,
         status, workout_gate_status,
         created_by, organization_id
       ) VALUES (
         $1, COALESCE($2, CURRENT_DATE), (SELECT COUNT(*)+1 FROM pt_parq_forms WHERE client_id = $1),
         $3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,
         $15::jsonb,$16::jsonb,
         $17::jsonb,$18,
         $19,$20,
         $21::jsonb,
         $22,$23,
         $24,$25
       ) RETURNING id`,
      [
        b.client_id, b.assessment_date || null,
        b.full_name, b.gender || null, b.dob || null, b.mobile || null, b.email || null,
        b.emergency_contact || null, b.emergency_phone || null, b.blood_group || null,
        b.height_cm ?? null, b.weight_kg ?? null, bmi ?? null, b.trainer_name || null,
        b.current_health ? JSON.stringify(b.current_health) : null,
        b.past_history ? JSON.stringify(b.past_history) : null,
        JSON.stringify(b.parq_answers), analysis.yesCount,
        analysis.riskLevel, analysis.riskMessage,
        b.trainer_notes ? JSON.stringify(b.trainer_notes) : null,
        b.status || 'submitted', gateStatus,
        req.user.id, orgIdOf(req),
      ]
    );
    formId = rows[0].id;

    await replaceFamilyHistory(tx, formId, b.family_history);

    await tx.query('COMMIT');
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }

  // Authoritative recompute after commit (accounts for any pre-existing
  // approved medical clearance — unlikely on first submit, but keeps this
  // the single source of truth for gate status everywhere).
  await recomputeGateStatus(pool, formId);

  await logActivity(req, 'parq.submit', 'pt_parq_forms', formId, {
    client_id: b.client_id, risk_level: analysis.riskLevel, yes_count: analysis.yesCount,
  });

  const { rows: finalRows } = await pool.query('SELECT * FROM pt_parq_forms WHERE id = $1', [formId]);
  res.status(201).json({ data: finalRows[0] });
}));

// PATCH /parq/forms/:id
router.patch('/parq/forms/:id', auth, requireRole('admin', 'manager', 'trainer'), wrap(async (req, res) => {
  const { id } = req.params;
  const b = req.body;

  const allowedScalar = [
    'assessment_date', 'full_name', 'gender', 'dob', 'mobile', 'email',
    'emergency_contact', 'emergency_phone', 'blood_group',
    'height_cm', 'weight_kg', 'bmi', 'trainer_name',
    'current_health', 'past_history', 'parq_answers', 'trainer_notes', 'status',
  ];
  const jsonFields = new Set(['current_health', 'past_history', 'parq_answers', 'trainer_notes']);

  const tx = await pool.connect();
  let formId;
  try {
    await tx.query('BEGIN');
    const scope = tenantScope(req);
    const upGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
    const { rows: existingRows } = await tx.query(
      `SELECT * FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${upGuard} FOR UPDATE`,
      scope.applyFilter ? [id, scope.orgId] : [id]
    );
    const existing = existingRows[0];
    if (!existing) {
      await tx.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }

    const mergedAnswers = b.parq_answers !== undefined ? b.parq_answers : existing.parq_answers;
    const analysis = computeParqAnalysis(mergedAnswers);
    const gateStatus = analysis.riskLevel === 'high' ? 'blocked' : 'cleared';

    let bmi;
    if (b.bmi !== undefined) {
      bmi = b.bmi;
    } else if (b.height_cm !== undefined || b.weight_kg !== undefined) {
      const mergedHeight = b.height_cm !== undefined ? b.height_cm : existing.height_cm;
      const mergedWeight = b.weight_kg !== undefined ? b.weight_kg : existing.weight_kg;
      bmi = calcBmi(mergedWeight, mergedHeight);
    } else {
      bmi = existing.bmi;
    }

    const sets = [];
    const params = [id];
    for (const key of allowedScalar) {
      if (b[key] !== undefined) {
        const isJson = jsonFields.has(key) && b[key] !== null && b[key] !== undefined;
        params.push(isJson ? JSON.stringify(b[key]) : b[key]);
        sets.push(`${key} = $${params.length}${isJson ? '::jsonb' : ''}`);
      }
    }

    // Derived columns are always refreshed — even a family-history-only
    // edit still needs risk fields recomputed from the (possibly merged)
    // parq_answers so they never drift.
    for (const [col, val] of Object.entries({
      parq_yes_count: analysis.yesCount, risk_level: analysis.riskLevel, risk_message: analysis.riskMessage,
      bmi, workout_gate_status: gateStatus,
    })) {
      params.push(val); sets.push(`${col} = $${params.length}`);
    }

    sets.push('updated_at = NOW()');
    await tx.query(`UPDATE pt_parq_forms SET ${sets.join(', ')} WHERE id = $1`, params);

    if (b.family_history !== undefined) {
      await replaceFamilyHistory(tx, id, b.family_history);
    }

    await tx.query('COMMIT');
    formId = id;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }

  // Authoritative recompute — approving a clearance earlier may already
  // have cleared the gate; this re-confirms against the clearance table
  // rather than trusting the tentative value written above.
  await recomputeGateStatus(pool, formId);

  const { rows } = await pool.query('SELECT * FROM pt_parq_forms WHERE id = $1', [formId]);
  res.json({ data: rows[0] });
}));

// ─── Medical Clearance ──────────────────────────────────────

// POST /parq/forms/:formId/clearance
router.post('/parq/forms/:formId/clearance', auth, requireRole('admin', 'manager', 'trainer'), validate(clearanceCreateSchema), wrap(async (req, res) => {
  const { formId } = req.params;
  const scope = tenantScope(req);
  const clGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: formRows } = await pool.query(
    `SELECT client_id, organization_id FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${clGuard}`,
    scope.applyFilter ? [formId, scope.orgId] : [formId]
  );
  const form = formRows[0];
  if (!form) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const b = req.body;
  const { rows } = await pool.query(
    `INSERT INTO pt_medical_clearances (
       parq_form_id, client_id, doctor_name, hospital, clearance_date,
       certificate_url, doctor_contact, expiry_date, approval_status, organization_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      formId, form.client_id, b.doctor_name || null, b.hospital || null, b.clearance_date || null,
      b.certificate_url || null, b.doctor_contact || null, b.expiry_date || null, b.approval_status || 'pending',
      form.organization_id,
    ]
  );

  const gate = await recomputeGateStatus(pool, formId);
  res.status(201).json({ data: { ...rows[0], gate } });
}));

// PATCH /parq/clearance/:id
router.patch('/parq/clearance/:id', auth, requireRole('admin', 'manager', 'trainer'), wrap(async (req, res) => {
  const allowed = ['doctor_name', 'hospital', 'clearance_date', 'certificate_url', 'doctor_contact', 'expiry_date', 'approval_status'];

  const scope = tenantScope(req);
  const mcGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_medical_clearances WHERE id = $1${mcGuard}`,
    scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const sets = [];
  const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { params.push(req.body[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const statusChanged = req.body.approval_status !== undefined && req.body.approval_status !== existing.approval_status;
  if (statusChanged) {
    params.push(req.user.id); sets.push(`reviewed_by = $${params.length}`);
    sets.push('reviewed_at = NOW()');
  }
  sets.push('updated_at = NOW()');

  const { rows } = await pool.query(`UPDATE pt_medical_clearances SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  const updated = rows[0];

  const gate = await recomputeGateStatus(pool, updated.parq_form_id);

  if (statusChanged) {
    const action = updated.approval_status === 'approved' ? 'parq.clearance.approve'
      : updated.approval_status === 'rejected' ? 'parq.clearance.reject'
      : 'parq.clearance.update';
    await logActivity(req, action, 'pt_medical_clearances', updated.id, {
      formId: updated.parq_form_id, approval_status: updated.approval_status,
    });
  }

  res.json({ data: { ...updated, gate } });
}));

// ─── Digital Consent ────────────────────────────────────────

// POST /parq/forms/:formId/consent
//
// Role check: `auth` only, no requireRole. This app is staff-operated
// (audited earlier — there is no separate PT-client login; `pt_clients`
// rows have no linked `users` account, unlike gym `member`-role users).
// Consent is signed in person on a staff device during onboarding, so
// requiring admin/manager/trainer here is both accurate to how the form
// is actually used AND safer than opening it to any authenticated user
// (which would let an unrelated `member`-role account sign a consent
// record for a PT client they have no association with).
router.post('/parq/forms/:formId/consent', auth, requireRole('admin', 'manager', 'trainer'), validate(consentCreateSchema), wrap(async (req, res) => {
  const { formId } = req.params;
  const scope = tenantScope(req);
  const coGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: formRows } = await pool.query(
    `SELECT client_id, organization_id FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${coGuard}`,
    scope.applyFilter ? [formId, scope.orgId] : [formId]
  );
  const form = formRows[0];
  if (!form) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const b = req.body;
  const checkboxes = b.consent_checkboxes || {};
  const allAgreed = CONSENT_KEYS.every((k) => checkboxes[k] === true);
  if (!allAgreed) {
    return res.status(400).json({ error: 'All consent items must be agreed to' });
  }

  const ua = String(req.headers['user-agent'] || '');
  const device = /Mobile|Android|iPhone/i.test(ua) ? 'mobile' : /iPad|Tablet/i.test(ua) ? 'tablet' : 'desktop';
  const browser = /Chrome/i.test(ua) ? 'Chrome'
    : /Firefox/i.test(ua) ? 'Firefox'
    : /Safari/i.test(ua) ? 'Safari'
    : /Edge/i.test(ua) ? 'Edge'
    : 'Browser';

  const { rows } = await pool.query(
    `INSERT INTO pt_consent_records (
       parq_form_id, client_id, consent_checkboxes, client_signature, trainer_signature,
       client_signed_at, trainer_signed_at, ip_address, device, browser, location, organization_id
     ) VALUES ($1,$2,$3::jsonb,$4,$5,NOW(),NOW(),$6,$7,$8,$9,$10) RETURNING *`,
    [
      formId, form.client_id, JSON.stringify(checkboxes), b.client_signature || null, b.trainer_signature || null,
      req.ip || null, device, browser, b.location || null, form.organization_id,
    ]
  );
  let consentRecord = rows[0];

  // PDF generation failure shouldn't fail the consent capture itself — the
  // signed record is already durably stored; the PDF can be regenerated.
  try {
    const [formRes2, clearanceRes2] = await Promise.all([
      pool.query('SELECT * FROM pt_parq_forms WHERE id = $1', [formId]),
      pool.query('SELECT * FROM pt_medical_clearances WHERE parq_form_id = $1 ORDER BY created_at DESC LIMIT 1', [formId]),
    ]);
    const pdfUrl = await generateConsentPdf({
      form: formRes2.rows[0], clearance: clearanceRes2.rows[0] || null, consent: consentRecord,
    });
    const { rows: updatedRows } = await pool.query(
      'UPDATE pt_consent_records SET pdf_url = $1 WHERE id = $2 RETURNING *', [pdfUrl, consentRecord.id]
    );
    consentRecord = updatedRows[0];
  } catch (err) {
    logger.error({ err: err.message, formId }, 'parq consent PDF generation failed');
  }

  await logActivity(req, 'parq.consent.sign', 'pt_consent_records', consentRecord.id, { formId });
  res.status(201).json({ data: consentRecord });
}));

// ─── Document Uploads ───────────────────────────────────────

// Multer + memoryStorage + magic-byte-sniff, following the pattern in
// src/routes/profile.js's avatar upload — MIME header alone can be spoofed,
// so the actual file bytes are checked before trusting the extension.
const PARQ_MAX_UPLOAD_BYTES = parseInt(process.env.PARQ_MAX_UPLOAD_BYTES, 10) || 10 * 1024 * 1024; // 10MB default, configurable
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PARQ_MAX_UPLOAD_BYTES },
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

const DOC_TYPES = ['medical_report', 'medical_certificate', 'other'];

// POST /parq/forms/:formId/documents
router.post('/parq/forms/:formId/documents', auth, requireRole('admin', 'manager', 'trainer'), docUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File is required' });

  const { formId } = req.params;
  const scope = tenantScope(req);
  const dGuard = scope.applyFilter ? ' AND organization_id = $2' : '';
  const { rows: formRows } = await pool.query(
    `SELECT client_id, organization_id FROM pt_parq_forms WHERE id = $1 AND deleted_at IS NULL${dGuard}`,
    scope.applyFilter ? [formId, scope.orgId] : [formId]
  );
  const form = formRows[0];
  if (!form) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const detected = detectFileType(req.file.buffer);
  if (!detected) {
    return res.status(400).json({ error: 'File content does not match an allowed type (PNG, JPG, PDF)' });
  }

  const docType = DOC_TYPES.includes(req.body.doc_type) ? req.body.doc_type : 'other';

  const filename = `${formId}-${Date.now()}.${detected.ext}`;
  const fileUrl = await saveFile('parq', filename, req.file.buffer, detected.mime,
    { organizationId: req.user?.organization_id, uploadedBy: req.user?.id });

  const { rows } = await pool.query(
    `INSERT INTO pt_parq_documents (parq_form_id, client_id, doc_type, file_name, file_url, mime_type, size_bytes, uploaded_by, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [formId, form.client_id, docType, req.file.originalname || filename, fileUrl, detected.mime, req.file.size, req.user.id, form.organization_id]
  );
  res.status(201).json({ data: rows[0] });
}));

module.exports = router;
