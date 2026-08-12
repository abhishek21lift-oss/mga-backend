'use strict';
// src/workers/subscription.worker.js
// Studio-subscription background sweep for MY PT STUDIO:
//   1. Freeze studios whose 7-day trial has lapsed (persist status for display;
//      access is already enforced lazily by the auth layer).
//   2. Expire studios whose paid period has ended.
//   3. Send 7 / 3 / 1-day and expiry-day reminders, plus frozen notifications, to
//      each studio's admin users (in-app).
//
// Every step is idempotent and reminders are de-duplicated via subscription_events,
// so running this repeatedly (interval or cron) never double-freezes or double-
// notifies. Run standalone (`node src/workers/subscription.worker.js`) or let the
// in-process scheduler in server.js call runSubscriptionSweep().

const pool = require('../db/pool');
const logger = require('../lib/logger');
const subscription = require('../lib/subscription');

const REMINDER_DAYS = [7, 3, 1, 0]; // 0 = expiry day

// In-app notification to every active admin of a studio.
async function notifyStudioAdmins(orgId, title, body, link) {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE organization_id = $1 AND role = 'admin' AND is_active = true AND deleted_at IS NULL`,
    [orgId]
  );
  for (const u of rows) {
    try {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'subscription',$2,$3,$4)`,
        [u.id, title, body, link || '/subscription']
      );
    } catch (err) { logger.warn({ err: err.message, orgId }, 'subscription notify failed'); }
  }
}

async function logEvent(orgId, event, data) {
  try {
    await pool.query(
      `INSERT INTO subscription_events (organization_id, event, data) VALUES ($1,$2,$3)`,
      [orgId, event, data ? JSON.stringify(data) : null]
    );
  } catch { /* best-effort */ }
}

// True if a reminder for this (org, kind, days) was already logged in the last ~20h.
async function reminderAlreadySent(orgId, kind, days) {
  const { rows } = await pool.query(
    `SELECT 1 FROM subscription_events
      WHERE organization_id = $1 AND event = 'reminder_sent'
        AND data->>'kind' = $2 AND (data->>'days')::int = $3
        AND created_at > now() - interval '20 hours' LIMIT 1`,
    [orgId, kind, days]
  );
  return rows.length > 0;
}

// ── 1 & 2: freeze lapsed trials / expire lapsed subscriptions ─────────────────
async function sweepExpiries() {
  const { rows: frozen } = await pool.query(
    `UPDATE organizations SET subscription_status='frozen', updated_at=now()
      WHERE subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at < now()
      RETURNING id, name`
  );
  for (const o of frozen) {
    await logEvent(o.id, 'frozen', { reason: 'trial_expired' });
    await notifyStudioAdmins(o.id, 'Your trial has expired',
      'Please subscribe to continue using MY PT STUDIO. Your data is safe.', '/subscription');
  }

  const { rows: expired } = await pool.query(
    `UPDATE organizations SET subscription_status='expired', updated_at=now()
      WHERE subscription_status='active' AND current_period_end IS NOT NULL AND current_period_end < now()
      RETURNING id, name`
  );
  for (const o of expired) {
    await logEvent(o.id, 'expired', { reason: 'period_ended' });
    await notifyStudioAdmins(o.id, 'Your subscription has expired',
      'Please renew to continue using MY PT STUDIO. Your data is safe.', '/subscription');
  }

  if (frozen.length || expired.length) logger.info({ frozen: frozen.length, expired: expired.length }, 'subscription sweep');
  return { frozen: frozen.length, expired: expired.length };
}

// ── 3: 7/3/1/0-day reminders for trials and active subscriptions ──────────────
async function sendReminders() {
  let sent = 0;
  for (const days of REMINDER_DAYS) {
    // Trials ending in `days` days.
    const { rows: trials } = await pool.query(
      `SELECT id, name FROM organizations
        WHERE subscription_status='trial' AND trial_ends_at IS NOT NULL
          AND (trial_ends_at::date - CURRENT_DATE) = $1`, [days]
    );
    for (const o of trials) {
      if (await reminderAlreadySent(o.id, 'trial', days)) continue;
      const msg = days === 0 ? 'Your free trial ends today. Subscribe to keep access.'
        : `Your free trial ends in ${days} ${days === 1 ? 'day' : 'days'}. Subscribe to keep access.`;
      await notifyStudioAdmins(o.id, 'Trial ending soon', msg, '/subscription');
      await logEvent(o.id, 'reminder_sent', { kind: 'trial', days });
      sent++;
    }

    // Active subscriptions renewing in `days` days.
    const { rows: subs } = await pool.query(
      `SELECT id, name FROM organizations
        WHERE subscription_status='active' AND current_period_end IS NOT NULL
          AND (current_period_end::date - CURRENT_DATE) = $1`, [days]
    );
    for (const o of subs) {
      if (await reminderAlreadySent(o.id, 'renewal', days)) continue;
      const msg = days === 0 ? 'Your subscription renews today.'
        : `Your subscription renews in ${days} ${days === 1 ? 'day' : 'days'}.`;
      await notifyStudioAdmins(o.id, 'Renewal reminder', msg, '/subscription');
      await logEvent(o.id, 'reminder_sent', { kind: 'renewal', days });
      sent++;
    }
  }
  if (sent) logger.info({ sent }, 'subscription reminders sent');
  return { sent };
}

// Scheduled downgrades come due at period end. Applied before the expiry sweep
// so a studio that downgrades and renews in the same window lands on the new
// plan's limit rather than the old one.
async function applyScheduledDowngrades() {
  const applied = await subscription.applyDueDowngrades();
  if (applied.length) {
    logger.info({ count: applied.length, changes: applied }, 'scheduled downgrades applied');
  }
  return applied;
}

async function runSubscriptionSweep() {
  try {
    await applyScheduledDowngrades();
    await sweepExpiries();
    await sendReminders();
  } catch (err) {
    logger.error({ err: err.message }, 'subscription sweep failed');
  }
}

async function main() {
  await runSubscriptionSweep();
  process.exit(0);
}

if (require.main === module) main();

module.exports = { runSubscriptionSweep, sweepExpiries, sendReminders, notifyStudioAdmins, applyScheduledDowngrades };
