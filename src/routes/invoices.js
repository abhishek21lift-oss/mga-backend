// src/routes/invoices.js — Invoices CRUD + actions
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');
const logger = require('../lib/logger');

// GET /api/invoices — List invoices
router.get('/', auth, async (req, res, next) => {
  try {
    const { status, search, from, to, limit = 100, offset = 0 } = req.query;
    const conds = [];
    const params = [];
    let p = 1;

    // Multi-tenant isolation: only the caller's org's invoices.
    const scope = tenantScope(req);
    if (scope.applyFilter) { conds.push(`i.organization_id = $${p++}`); params.push(scope.orgId); }

    if (status && status !== 'all') {
      conds.push(`i.status = $${p++}`);
      params.push(status);
    }
    if (search) {
      conds.push(`(i.client_name ILIKE $${p} OR i.invoice_no ILIKE $${p})`);
      params.push(`%${search}%`);
      p++;
    }
    if (from) { conds.push(`i.issue_date >= $${p++}`); params.push(from); }
    if (to)   { conds.push(`i.issue_date <= $${p++}`); params.push(to); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const { rows } = await pool.query(`
      SELECT i.*,
        pc.photo_url AS client_photo,
        COALESCE((SELECT json_agg(json_build_object(
          'id', ii.id,
          'description', ii.description,
          'quantity', ii.quantity,
          'unit_price', ii.unit_price,
          'amount', ii.amount,
          'type', ii.type
        )) FROM invoice_items ii WHERE ii.invoice_id = i.id), '[]'::json) AS items
      FROM invoices i
      -- Only for the client's face on the list. The org equality is part of
      -- the join rather than assumed from i.client_id: an invoice carries a
      -- denormalised client_name and a nullable client_id, and this must not
      -- become a way to read a row from another tenant. Legacy rows with a
      -- NULL organization_id match nothing and fall back to initials.
      LEFT JOIN pt_clients pc
        ON pc.id = i.client_id
       AND pc.organization_id = i.organization_id
       AND pc.deleted_at IS NULL
      ${where}
      ORDER BY i.issue_date DESC, i.created_at DESC
      LIMIT $${p++} OFFSET $${p++}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    // Stats (same tenant scope as the list)
    const statsWhere  = scope.applyFilter ? 'WHERE organization_id = $1' : '';
    const statsParams = scope.applyFilter ? [scope.orgId] : [];
    const { rows: stats } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid'), 0) AS paid,
        COALESCE(SUM(total_amount) FILTER (WHERE status IN ('draft','sent','partial')), 0) AS pending,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'overdue'), 0) AS overdue
      FROM invoices
      ${statsWhere}
    `, statsParams);

    res.json({ invoices: rows, stats: stats[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/invoices/:id
router.get('/:id', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const guard = scope.applyFilter ? ' AND i.organization_id = $2' : '';
    const params = scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id];
    const { rows } = await pool.query(`
      SELECT i.*,
        COALESCE((SELECT json_agg(json_build_object(
          'id', ii.id,
          'description', ii.description,
          'quantity', ii.quantity,
          'unit_price', ii.unit_price,
          'amount', ii.amount,
          'type', ii.type
        )) FROM invoice_items ii WHERE ii.invoice_id = i.id), '[]'::json) AS items
      FROM invoices i WHERE i.id = $1${guard}`, params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices — Create invoice
router.post('/', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    const d = req.body;

    // Accept both the structured form {client_id, items[]} and the simplified
    // form {member_name, amount, description, due_date} that the frontend sends.
    const isSimplified = !d.client_id && !d.items?.length && (d.member_name || d.amount);
    if (!isSimplified && !d.client_id && !d.items?.length)
      return res.status(400).json({ error: 'client_id and items[] required' });

    await tx.query('BEGIN');

    const clientId = d.client_id || null;
    let clientName = d.client_name || d.member_name || '';

    // Structured form: look up the client (pt_clients is the live client
    // table — the legacy `clients` table has been empty since PT-OS shipped)
    if (!isSimplified) {
      // Multi-tenant isolation: the client must belong to the caller's
      // organization. Without the org predicate this lookup accepted ANY
      // client id, so a caller could invoice against another studio's client
      // and read that client's name back in the 201 response — a cross-tenant
      // disclosure on a route that otherwise stamps the invoice with the
      // caller's own org. 404 rather than 403, matching payments.js and
      // mark-paid below, so a miss never confirms the id exists elsewhere.
      const cScope = tenantScope(req);
      const cParams = [d.client_id];
      let cGuard = '';
      if (cScope.applyFilter) {
        cParams.push(cScope.orgId);
        cGuard = ` AND organization_id = $${cParams.length}`;
      }
      const { rows: cl } = await tx.query(
        `SELECT id, name FROM pt_clients WHERE id=$1 AND deleted_at IS NULL${cGuard}`, cParams
      );
      if (!cl[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found' }); }
      clientName = cl[0].name;
    }

    const id = randomUUID();
    const invNo = 'INV-' + Date.now();
    let subtotal = 0;

    if (isSimplified) {
      subtotal = parseFloat(d.amount) || 0;
    } else {
      for (const item of d.items) {
        const amt = (parseFloat(item.unit_price) || 0) * (parseInt(item.quantity) || 1);
        subtotal += amt;
      }
    }

    const taxPct = parseFloat(d.tax_pct) || 0;
    const taxAmt = subtotal * (taxPct / 100);
    const total = subtotal + taxAmt;

    await tx.query(`
      INSERT INTO invoices (id, invoice_no, client_id, client_name, amount, tax_amount, total_amount,
        status, due_date, issue_date, payment_method, notes, created_by, organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, invNo, clientId, clientName, subtotal, taxAmt, total,
       d.status || 'draft', d.due_date || null, d.issue_date || new Date().toISOString().split('T')[0],
       d.payment_method || null, d.notes || d.description || null, req.user.id, orgIdOf(req)]
    );

    if (!isSimplified) {
      for (const item of d.items) {
        const amt = (parseFloat(item.unit_price) || 0) * (parseInt(item.quantity) || 1);
        await tx.query(`
          INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, type)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), id, item.description, parseInt(item.quantity) || 1,
           parseFloat(item.unit_price) || 0, amt, item.type || 'other']
        );
      }
    } else if (d.description) {
      // Create a single line item from the simplified form
      await tx.query(`
        INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, type)
        VALUES ($1,$2,$3,1,$4,$5,'other')`,
        [randomUUID(), id, d.description, subtotal, subtotal]
      );
    }

    await tx.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM invoices WHERE id=$1', [id]);
    res.status(201).json({ message: 'Invoice created', invoice: rows[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    logger.error({ err: err.message }, 'Invoice creation error');
    next(err);
  } finally {
    tx.release();
  }
});

// PUT /api/invoices/:id — Update invoice
router.put('/:id', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const gCol = scope.applyFilter ? ' AND organization_id = $2' : '';
    const gParams = scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id];
    const { rows: ex } = await pool.query(
      `SELECT * FROM invoices WHERE id=$1${gCol}`, gParams
    );
    if (!ex[0]) return res.status(404).json({ error: 'Invoice not found' });
    if (ex[0].status === 'paid')
      return res.status(400).json({ error: 'Cannot update a paid invoice' });

    const d = req.body;
    const { rows } = await pool.query(`
      UPDATE invoices SET
        status = COALESCE($1, status),
        payment_method = COALESCE($2, payment_method),
        notes = COALESCE($3, notes),
        due_date = COALESCE($4, due_date),
        updated_at = NOW()
      WHERE id = $5 RETURNING *`,
      [d.status || ex[0].status, d.payment_method ?? ex[0].payment_method,
       d.notes ?? ex[0].notes, d.due_date ?? ex[0].due_date, req.params.id]
    );
    res.json({ message: 'Invoice updated', invoice: rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/send — Mark as sent
router.post('/:id/send', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
    const params = scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id];
    const { rows } = await pool.query(
      `UPDATE invoices SET status='sent', sent_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status='draft'${guard} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found or already sent' });
    res.json({ message: 'Invoice sent', invoice: rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/mark-paid
router.post('/:id/mark-paid', auth, async (req, res, next) => {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const scope = tenantScope(req);
    const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
    const params = scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id];
    const { rows: inv } = await tx.query(
      `UPDATE invoices SET status='paid', paid_at=NOW(), paid_amount=total_amount, updated_at=NOW()
       WHERE id=$1 AND status IN ('sent','draft','partial','overdue')${guard} RETURNING *`,
      params
    );
    if (!inv[0]) { await tx.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found or already paid' }); }

    // Also record as a payment if not already recorded
    const receiptNo = 'INV-' + inv[0].invoice_no;
    await tx.query(`
      INSERT INTO payments (id, client_id, client_name, trainer_id, amount, method, date, receipt_no, notes, created_at)
      VALUES ($1, $2, $3, NULL, $4, $5, CURRENT_DATE, $6, $7, NOW())
      ON CONFLICT DO NOTHING`,
      [randomUUID(), inv[0].client_id, inv[0].client_name, inv[0].total_amount,
       req.body.payment_method || 'CASH', receiptNo, 'Payment for invoice ' + inv[0].invoice_no]
    );

    // Update the linked client's paid/balance fields so their financial record
    // stays correct. pt_clients is the live client table (the legacy `clients`
    // table has been empty since PT-OS shipped), and invoices.client_id keys
    // into it — so this is what actually reflects the payment on the client.
    if (inv[0].client_id) {
      await tx.query(`
        UPDATE pt_clients
        SET paid_amount    = COALESCE(paid_amount, 0) + $1,
            balance_amount = GREATEST(0, COALESCE(balance_amount, 0) - $1),
            updated_at     = NOW()
        WHERE id = $2 AND deleted_at IS NULL`,
        [inv[0].total_amount, inv[0].client_id]
      );
    }

    await tx.query('COMMIT');
    res.json({ message: 'Invoice marked as paid', invoice: inv[0] });
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    tx.release();
  }
});

// POST /api/invoices/:id/remind
router.post('/:id/remind', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
    const params = scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id];
    const { rows } = await pool.query(`SELECT * FROM invoices WHERE id=$1${guard}`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    logger.info({ invoiceId: req.params.id, userId: req.user.id }, 'Payment reminder sent');
    res.json({ message: 'Reminder sent to ' + rows[0].client_name });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/cancel
router.post('/:id/cancel', auth, async (req, res, next) => {
  try {
    const scope = tenantScope(req);
    const guard = scope.applyFilter ? ' AND organization_id = $2' : '';
    const params = scope.applyFilter ? [req.params.id, scope.orgId] : [req.params.id];
    const { rows } = await pool.query(
      `UPDATE invoices SET status='cancelled', cancelled_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND status NOT IN ('paid','cancelled')${guard} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found or cannot be cancelled' });
    res.json({ message: 'Invoice cancelled', invoice: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
