'use strict';
/**
 * Propose → confirm → execute, for the things the assistant can actually do.
 *
 * The whole point of this module is that the model is not in the write path.
 * It can put a proposal in front of an operator; only the operator's explicit
 * confirmation runs it, and what runs is re-derived by the server rather than
 * taken from the request.
 *
 *   POST /api/ai/actions/:id/plan     read-only. Resolves who and what, stores
 *                                     it, returns it with a plan id.
 *   POST /api/ai/actions/:id/execute  takes { plan_id }. Re-resolves, refuses
 *                                     if the answer moved, claims the plan
 *                                     atomically, then delivers.
 *
 * Why re-resolve when the plan is already stored? Because between reading and
 * confirming, a client can be added, a payment can land, a package can lapse.
 * Executing the stored list would send to a set that no longer matches what
 * the operator approved; executing a freshly resolved list would send to
 * people they never saw. Comparing the two and refusing on a mismatch is the
 * only option that is honest in both directions — the operator re-reads and
 * re-confirms, which is cheap, and nobody gets messaged by surprise.
 */

const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const logger = require('../../lib/logger');
const { tenantScope } = require('../../lib/tenant-db');
const { findAction, canRun, listFor, deliver, MAX_RECIPIENTS } = require('./registry');

/** Long enough to read a list of twelve names and think about it; short
 *  enough that the world has probably not moved underneath it. */
const PLAN_TTL_MS = 5 * 60 * 1000;

/**
 * What the operator is agreeing to, reduced to one string.
 *
 * Recipient ids AND the exact message body, because "same twelve people" is
 * not the same approval as "same twelve people, different words". Sorted so
 * that a change in row order — which ORDER BY ties can produce — is not
 * mistaken for a change in the plan.
 */
function fingerprint(recipients) {
  const canonical = recipients
    .map((r) => `${r.id}:${r.body}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** The actions this caller may be offered at all. */
router.get('/actions', auth, (req, res) => {
  res.json({ data: listFor(req.user) });
});

router.post('/actions/:id/plan', auth, wrap(async (req, res) => {
  const action = findAction(req.params.id);
  if (!action) return res.status(404).json({ error: 'Unknown action' });
  if (!canRun(action, req.user)) {
    return res.status(403).json({ error: 'You do not have permission to run this action' });
  }

  const params = action.normalize(req.body);
  const { recipients, warnings } = await action.resolve(req, params);

  const summary = {
    action_id: action.id,
    title: action.title,
    description: action.describe(params),
    outward: Boolean(action.outward),
    count: recipients.length,
    // Enough to read, not the whole list — a plan is a confirmation screen,
    // not an export. The count above is the number that will be messaged.
    preview: recipients.slice(0, 8).map((r) => ({ name: r.name, detail: r.detail })),
    sample_message: recipients[0]?.body ?? null,
    warnings,
    truncated: recipients.length >= MAX_RECIPIENTS,
  };

  const scope = tenantScope(req);
  const { rows } = await pool.query(
    `INSERT INTO ai_action_plans
       (organization_id, user_id, action_id, fingerprint, params, summary, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' milliseconds')::INTERVAL)
     RETURNING id, expires_at`,
    [scope.orgId, req.user.id, action.id, fingerprint(recipients),
      JSON.stringify(params), JSON.stringify(summary), PLAN_TTL_MS],
  );

  res.json({ data: { plan_id: rows[0].id, expires_at: rows[0].expires_at, ...summary } });
}));

router.post('/actions/:id/execute', auth, wrap(async (req, res) => {
  const action = findAction(req.params.id);
  if (!action) return res.status(404).json({ error: 'Unknown action' });
  if (!canRun(action, req.user)) {
    return res.status(403).json({ error: 'You do not have permission to run this action' });
  }

  const planId = req.body?.plan_id;
  if (!planId) return res.status(400).json({ error: 'plan_id is required' });

  // Scoped to the confirming user, not just to the org: a plan is one
  // person's approval and is not transferable to a colleague's session.
  const { rows: found } = await pool.query(
    `SELECT id, action_id, fingerprint, params, consumed_at, expires_at
       FROM ai_action_plans
      WHERE id = $1 AND user_id = $2`,
    [planId, req.user.id],
  );
  const plan = found[0];
  if (!plan) return res.status(404).json({ error: 'That plan was not found' });
  if (plan.action_id !== action.id) {
    return res.status(400).json({ error: 'That plan belongs to a different action' });
  }
  if (plan.consumed_at) {
    return res.status(409).json({ error: 'That plan has already been run', code: 'already_run' });
  }
  if (new Date(plan.expires_at).getTime() <= Date.now()) {
    return res.status(409).json({ error: 'That plan has expired — please review it again', code: 'expired' });
  }

  // Re-derive. Nothing from the request body reaches this.
  const { recipients, warnings } = await action.resolve(req, plan.params);
  if (fingerprint(recipients) !== plan.fingerprint) {
    return res.status(409).json({
      error: 'The list changed since you reviewed it — please check it again',
      code: 'plan_stale',
      count: recipients.length,
    });
  }

  // Claim it. Two taps on Confirm race here, and exactly one wins: the second
  // UPDATE matches no row because consumed_at is no longer NULL.
  const { rowCount } = await pool.query(
    `UPDATE ai_action_plans SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
    [planId],
  );
  if (rowCount === 0) {
    return res.status(409).json({ error: 'That plan has already been run', code: 'already_run' });
  }

  const results = await deliver(recipients);
  const tally = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  await pool.query(
    `UPDATE ai_action_plans SET result = $2 WHERE id = $1`,
    [planId, JSON.stringify({ tally, at: new Date().toISOString() })],
  );

  logger.info(
    { action: action.id, plan_id: planId, user_id: req.user.id, tally },
    'ai_action_executed',
  );

  res.json({
    data: {
      // 'sent' is the only status that means a message left the building.
      // not_configured and failed are reported as themselves so the UI can
      // say what actually happened rather than counting them as success.
      tally,
      sent: tally.sent || 0,
      total: results.length,
      warnings,
      results,
    },
  });
}));

module.exports = router;
