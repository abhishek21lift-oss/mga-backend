'use strict';
// Platform billing and invoices — super-admin API.
//
// Extracted verbatim from the 4,248-line super-admin.routes.js (audit
// H-03). Route paths, order within this domain, and handler bodies are
// unchanged; super-admin.routes.js now mounts this router.

const router = require('express').Router();
const {
  audit, csvCell, pool,
} = require('./shared');
const platformBilling = require('../../../lib/platformBilling');
const { generateSubscriptionInvoicePdf } = require('../../../lib/subscriptionInvoicePdf');

const INVOICE_EXPORT_MAX = 10000;
const INVOICE_PAGE_MAX = 200;

// Editable settings, whitelisted. A blind Object.keys() loop over req.body
// would let a caller write id, updated_at or a column added later.
const BILLING_SETTING_FIELDS = [
  'legal_name', 'address_line1', 'address_line2', 'city', 'state', 'state_code',
  'postal_code', 'country', 'gstin', 'pan', 'email', 'phone',
  'gst_percent', 'prices_include_gst', 'invoice_prefix', 'invoice_notes',
];
const BILLING_PROFILE_FIELDS = [
  'billing_name', 'billing_email', 'billing_gstin', 'billing_address_line1',
  'billing_address_line2', 'billing_city', 'billing_state', 'billing_state_code',
  'billing_postal_code',
];

const INVOICE_SELECT = `
  SELECT i.id, i.invoice_number, i.organization_id, i.payment_id, i.plan_code,
         i.amount_inr, i.taxable_value_inr, i.gst_percent,
         i.cgst_inr, i.sgst_inr, i.igst_inr,
         i.period_start, i.period_end, i.status, i.issued_at,
         i.buyer_snapshot,
         o.name AS organization_name, o.slug AS organization_slug,
         o.billing_gstin, pl.name AS plan_name,
         p.method AS payment_method, p.reference AS payment_reference
    FROM subscription_invoices i
    LEFT JOIN organizations      o  ON o.id   = i.organization_id
    LEFT JOIN subscription_plans pl ON pl.code = i.plan_code
    LEFT JOIN subscription_payments p ON p.id  = i.payment_id`;

// Shared by the list, the totals and the export so all three can never
// describe different sets — the bug where an export quietly ignores the
// filters the operator is looking at.
function buildInvoiceFilter(query) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

  if (query.org_id) add('i.organization_id = $?::uuid', query.org_id);
  if (query.status) add('i.status = $?', query.status);
  if (query.plan_code) add('i.plan_code = $?', query.plan_code);
  if (query.from) add('i.issued_at >= $?::timestamptz', query.from);
  // Inclusive of the whole end day: an operator picking "to 31 March" means
  // through the 31st, not up to midnight at its start.
  if (query.to) add("i.issued_at < ($?::date + INTERVAL '1 day')", query.to);
  if (query.q) {
    params.push(`%${query.q}%`);
    const i = `$${params.length}`;
    where.push(`(i.invoice_number ILIKE ${i} OR o.name ILIKE ${i} OR p.reference ILIKE ${i})`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// ── GET /billing/settings ────────────────────────────────────────────────────
router.get('/billing/settings', async (req, res, next) => {
  try {
    res.json({ data: await platformBilling.loadSettings() });
  } catch (err) { next(err); }
});

// ── PUT /billing/settings ────────────────────────────────────────────────────
// Changing the rate affects invoices issued FROM NOW ON only; historical ones
// carry their own snapshot and are untouched. That is the whole point of the
// snapshot, and it is stated in the audit entry so the change is legible later.
router.put('/billing/settings', async (req, res, next) => {
  try {
    const patch = {};
    for (const f of BILLING_SETTING_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) patch[f] = req.body[f];
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'No fields to update' } });
    }
    if (patch.gst_percent != null) {
      const n = Number(patch.gst_percent);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'gst_percent must be between 0 and 100' } });
      }
      patch.gst_percent = n;
    }
    if (patch.prices_include_gst != null) patch.prices_include_gst = Boolean(patch.prices_include_gst);
    if (patch.invoice_prefix != null) {
      // The prefix becomes part of a UNIQUE invoice_number; punctuation in it
      // would produce numbers that are awkward to quote and search for.
      const p = String(patch.invoice_prefix).trim().toUpperCase();
      if (!/^[A-Z0-9]{1,10}$/.test(p)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'invoice_prefix must be 1–10 letters or digits' } });
      }
      patch.invoice_prefix = p;
    }
    for (const f of ['gstin', 'pan', 'state_code']) {
      if (patch[f] != null) patch[f] = String(patch[f]).trim().toUpperCase() || null;
    }

    const before = await platformBilling.loadSettings();

    const cols = Object.keys(patch);
    const sets = cols.map((c, i) => `${c} = $${i + 1}`);
    const { rows } = await pool.query(
      `UPDATE platform_billing_settings
          SET ${sets.join(', ')}, updated_at = now(), updated_by = $${cols.length + 1}
        WHERE id = TRUE
        RETURNING *`,
      [...cols.map((c) => patch[c]), req.user?.name || null]
    );

    const changed = {};
    for (const c of cols) if (String(before[c] ?? '') !== String(patch[c] ?? '')) changed[c] = { from: before[c] ?? null, to: patch[c] ?? null };
    await audit(req, 'billing_settings_updated', 'platform_billing', null, {
      changed,
      note: 'Applies to invoices issued from now on; existing invoices keep their snapshot.',
    });

    res.json({ data: { ...platformBilling.DEFAULTS, ...(rows[0] || {}) } });
  } catch (err) { next(err); }
});

// ── GET /billing/invoices ────────────────────────────────────────────────────
// Rows for the current page PLUS totals over the whole filtered set, because
// "revenue in this range" must not change when the operator turns the page.
router.get('/billing/invoices', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, INVOICE_PAGE_MAX);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { clause, params } = buildInvoiceFilter(req.query);

    const [list, totals] = await Promise.all([
      pool.query(
        `${INVOICE_SELECT} ${clause} ORDER BY i.issued_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT count(*)::int AS count,
                COALESCE(SUM(i.amount_inr) FILTER (WHERE i.status = 'paid'), 0)::numeric      AS gross_inr,
                COALESCE(SUM(i.taxable_value_inr) FILTER (WHERE i.status = 'paid'), 0)::numeric AS taxable_inr,
                COALESCE(SUM(COALESCE(i.cgst_inr,0) + COALESCE(i.sgst_inr,0) + COALESCE(i.igst_inr,0))
                         FILTER (WHERE i.status = 'paid'), 0)::numeric                        AS tax_inr,
                COALESCE(SUM(i.amount_inr) FILTER (WHERE i.status = 'refunded'), 0)::numeric  AS refunded_inr,
                count(*) FILTER (WHERE i.taxable_value_inr IS NULL)::int                      AS untaxed_count
           FROM subscription_invoices i
           LEFT JOIN organizations o ON o.id = i.organization_id
           LEFT JOIN subscription_payments p ON p.id = i.payment_id
           ${clause}`,
        params
      ),
    ]);

    const t = totals.rows[0];
    res.json({
      data: list.rows,
      totals: {
        count: t.count,
        gross_inr: Number(t.gross_inr),
        taxable_inr: Number(t.taxable_inr),
        tax_inr: Number(t.tax_inr),
        refunded_inr: Number(t.refunded_inr),
        // Surfaced rather than hidden: these are pre-migration-122 invoices
        // with no tax snapshot, so the tax total under-reports by their share.
        untaxed_count: t.untaxed_count,
      },
      page: { limit, offset, has_more: offset + list.rows.length < t.count },
    });
  } catch (err) { next(err); }
});

// ── GET /billing/invoices/export ─────────────────────────────────────────────
// CSV, opened in Excel by double-click. Not .xlsx: a real workbook would add a
// binary writer dependency to gain formatting nobody asked for, while CSV is
// what an accountant's software imports anyway.
router.get('/billing/invoices/export', async (req, res, next) => {
  try {
    const { clause, params } = buildInvoiceFilter(req.query);
    const { rows } = await pool.query(
      `${INVOICE_SELECT} ${clause} ORDER BY i.issued_at DESC LIMIT $${params.length + 1}`,
      [...params, INVOICE_EXPORT_MAX]
    );

    const header = ['Invoice No', 'Issue Date', 'Studio', 'Studio GSTIN', 'Plan',
      'Period Start', 'Period End', 'Taxable Value', 'GST %', 'CGST', 'SGST', 'IGST',
      'Total', 'Status', 'Payment Method', 'Payment Reference'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push([
        r.invoice_number,
        r.issued_at ? new Date(r.issued_at).toISOString().slice(0, 10) : '',
        r.organization_name,
        r.buyer_snapshot?.gstin || r.billing_gstin,
        r.plan_name || r.plan_code,
        r.period_start ? new Date(r.period_start).toISOString().slice(0, 10) : '',
        r.period_end ? new Date(r.period_end).toISOString().slice(0, 10) : '',
        // Passed through as null so csvCell emits a truly empty cell. A 0 here
        // would be summed by the spreadsheet and quietly understate the
        // taxable base for rows that simply have no snapshot.
        r.taxable_value_inr, r.gst_percent,
        r.cgst_inr, r.sgst_inr, r.igst_inr,
        r.amount_inr, r.status, r.payment_method, r.payment_reference,
      ].map(csvCell).join(','));
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="invoices-${stamp}.csv"`);
    await audit(req, 'billing_exported', 'subscription_invoice', null,
      { rows: rows.length, filters: req.query });
    // BOM so Excel reads it as UTF-8 rather than mojibake.
    res.send('﻿' + lines.join('\n'));
  } catch (err) { next(err); }
});

// ── GET /billing/invoices/:id/pdf ────────────────────────────────────────────
router.get('/billing/invoices/:id/pdf', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, o.name AS organization_name, o.billing_name, o.billing_gstin,
              o.billing_email, o.billing_address_line1, o.billing_address_line2,
              o.billing_city, o.billing_state, o.billing_postal_code,
              pl.name AS plan_name
         FROM subscription_invoices i
         LEFT JOIN organizations o       ON o.id   = i.organization_id
         LEFT JOIN subscription_plans pl ON pl.code = i.plan_code
        WHERE i.id = $1`,
      [req.params.id]
    );
    const invoice = rows[0];
    if (!invoice) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice not found' } });

    const [payment, settings] = await Promise.all([
      invoice.payment_id
        ? pool.query('SELECT * FROM subscription_payments WHERE id = $1', [invoice.payment_id])
          .then((r) => r.rows[0] || null)
        : Promise.resolve(null),
      platformBilling.loadSettings(),
    ]);

    const pdf = await generateSubscriptionInvoicePdf({
      invoice,
      payment,
      organization: {
        id: invoice.organization_id, name: invoice.organization_name,
        billing_name: invoice.billing_name, billing_gstin: invoice.billing_gstin,
        billing_email: invoice.billing_email,
        billing_address_line1: invoice.billing_address_line1,
        billing_address_line2: invoice.billing_address_line2,
        billing_city: invoice.billing_city, billing_state: invoice.billing_state,
        billing_postal_code: invoice.billing_postal_code,
      },
      settings,
      planName: invoice.plan_name,
    });

    res.setHeader('Content-Type', 'application/pdf');
    // inline: an operator almost always wants to look at it before sending it
    // on, and the browser's viewer still offers Save.
    res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);
    res.send(pdf);
  } catch (err) { next(err); }
});

// ── GET|PUT /organizations/:id/billing-profile ───────────────────────────────
// The studio's registered identity, used on invoices issued from now on.
// Editing it does NOT retro-fit existing invoices: those carry their own buyer
// snapshot, and silently re-addressing an issued tax invoice would break the
// document's evidentiary value.
router.get('/organizations/:id/billing-profile', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, ${BILLING_PROFILE_FIELDS.join(', ')} FROM organizations WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.put('/organizations/:id/billing-profile', async (req, res, next) => {
  try {
    const patch = {};
    for (const f of BILLING_PROFILE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) {
        const v = req.body[f];
        patch[f] = v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 300);
      }
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'No fields to update' } });
    }
    for (const f of ['billing_gstin', 'billing_state_code']) {
      if (patch[f]) patch[f] = patch[f].toUpperCase();
    }

    const { rows: existing } = await pool.query(
      `SELECT id, ${BILLING_PROFILE_FIELDS.join(', ')} FROM organizations WHERE id = $1`,
      [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });

    const cols = Object.keys(patch);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`);
    const { rows } = await pool.query(
      `UPDATE organizations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1
        RETURNING id, name, ${BILLING_PROFILE_FIELDS.join(', ')}`,
      [req.params.id, ...cols.map((c) => patch[c])]
    );

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'billing_profile_updated','organization',$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.user?.name || null, req.params.id,
       existing[0], patch, req.ip || null, req.get('user-agent') || null]
    );

    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  FEATURE MANAGER
//
//  The control plane for what the product can do: a catalogue of capabilities,
//  which plans include them, and per-studio overrides.
//
//  Enforcement is deliberately NOT wired to any existing route — see the note
//  on requireFeature() in lib/features.js. This module builds and audits the
//  switches; turning one against a live studio is an operator's decision, and
//  every one of those decisions is recorded here.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = router;
