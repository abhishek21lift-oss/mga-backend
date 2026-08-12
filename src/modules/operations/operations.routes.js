const express = require('express');
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { branchScope } = require('../../middleware/branch-scope');

const router = express.Router();

const MIGRATION_MESSAGE = 'operations table not migrated. Run npm run migrate.';

function isMissingSchema(err) {
  return err && ['42P01', '42703'].includes(err.code);
}

function recordFromRow(row) {
  const dueDate = row.due_date instanceof Date
    ? row.due_date.toISOString().slice(0, 10)
    : String(row.due_date || '').slice(0, 10);
  return {
    id: row.id,
    title: row.title,
    owner: row.owner,
    status: row.status,
    priority: row.priority,
    amount: Number(row.amount || 0),
    dueDate,
    channel: row.channel,
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at || undefined,
  };
}

function validate(body) {
  const required = ['title', 'owner', 'status', 'priority', 'dueDate', 'channel'];
  for (const field of required) {
    if (!String(body[field] || '').trim()) {
      const err = new Error(`${field} is required`);
      err.status = 400;
      throw err;
    }
  }
  if (Number(body.amount) < 0 || Number.isNaN(Number(body.amount))) {
    const err = new Error('amount must be zero or greater');
    err.status = 400;
    throw err;
  }
}

function cleanModuleKey(moduleKey) {
  const key = String(moduleKey || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(key)) {
    const err = new Error('Invalid module key');
    err.status = 400;
    throw err;
  }
  return key;
}

function scopedClause(req, params) {
  const branchId = req.branchScope && req.branchScope.branchId;
  if (!branchId || (req.branchScope && req.branchScope.isAdmin)) return 'TRUE';
  params.push(branchId);
  return `(branch_id = $${params.length} OR branch_id IS NULL)`;
}

function branchForWrite(req) {
  if (req.branchScope && req.branchScope.isAdmin) {
    return req.body.branch_id || req.body.branchId || null;
  }
  return (req.branchScope && req.branchScope.branchId) || null;
}

router.use(auth, branchScope);

router.get('/:moduleKey', async (req, res, next) => {
  let moduleKey;
  try {
    moduleKey = cleanModuleKey(req.params.moduleKey);
  } catch (err) {
    return next(err);
  }

  const params = [moduleKey];
  const scope = scopedClause(req, params);
  try {
    const { rows } = await pool.query(
      `SELECT id, title, owner, status, priority, amount, due_date, channel, notes, created_at, updated_at
         FROM module_records
        WHERE module_key = $1
          AND deleted_at IS NULL
          AND ${scope}
        ORDER BY due_date ASC, created_at DESC
        LIMIT 500`,
      params
    );
    res.json(rows.map(recordFromRow));
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: MIGRATION_MESSAGE });
    next(err);
  }
});

router.post('/:moduleKey', async (req, res, next) => {
  try {
    const moduleKey = cleanModuleKey(req.params.moduleKey);
    validate(req.body);
    const branchId = branchForWrite(req);
    const createdBy = req.user && req.user.id;
    const { rows } = await pool.query(
      `INSERT INTO module_records
        (module_key, title, owner, status, priority, amount, due_date, channel, notes, branch_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, title, owner, status, priority, amount, due_date, channel, notes, created_at, updated_at`,
      [
        moduleKey,
        String(req.body.title).trim(),
        String(req.body.owner).trim(),
        String(req.body.status).trim(),
        String(req.body.priority).trim(),
        Number(req.body.amount || 0),
        String(req.body.dueDate).slice(0, 10),
        String(req.body.channel).trim(),
        String(req.body.notes || '').trim(),
        branchId,
        createdBy || null,
      ]
    );
    res.status(201).json(recordFromRow(rows[0]));
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: MIGRATION_MESSAGE });
    next(err);
  }
});

router.put('/:moduleKey/:id', async (req, res, next) => {
  try {
    const moduleKey = cleanModuleKey(req.params.moduleKey);
    validate(req.body);
    const params = [
      String(req.body.title).trim(),
      String(req.body.owner).trim(),
      String(req.body.status).trim(),
      String(req.body.priority).trim(),
      Number(req.body.amount || 0),
      String(req.body.dueDate).slice(0, 10),
      String(req.body.channel).trim(),
      String(req.body.notes || '').trim(),
      moduleKey,
      req.params.id,
    ];
    const scope = scopedClause(req, params);
    const { rows } = await pool.query(
      `UPDATE module_records
          SET title = $1,
              owner = $2,
              status = $3,
              priority = $4,
              amount = $5,
              due_date = $6,
              channel = $7,
              notes = $8
        WHERE module_key = $9
          AND id = $10
          AND deleted_at IS NULL
          AND ${scope}
        RETURNING id, title, owner, status, priority, amount, due_date, channel, notes, created_at, updated_at`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Record not found' });
    res.json(recordFromRow(rows[0]));
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: MIGRATION_MESSAGE });
    next(err);
  }
});

router.delete('/:moduleKey/:id', async (req, res, next) => {
  try {
    const moduleKey = cleanModuleKey(req.params.moduleKey);
    const params = [moduleKey, req.params.id];
    const scope = scopedClause(req, params);
    const { rows } = await pool.query(
      `UPDATE module_records
          SET deleted_at = NOW()
        WHERE module_key = $1
          AND id = $2
          AND deleted_at IS NULL
          AND ${scope}
        RETURNING id`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Record not found' });
    res.json({ message: 'Record deleted' });
  } catch (err) {
    if (isMissingSchema(err)) return res.status(503).json({ error: MIGRATION_MESSAGE });
    next(err);
  }
});

module.exports = router;
