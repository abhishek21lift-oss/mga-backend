// src/workers/renewal.worker.js
// Membership maintenance: expiry reminders + auto-renew (charged via Razorpay)
// + class reminders.
//
// ── STATUS after Phase 3 ────────────────────────────────────────────────────
//
//   Expiry sweep      WORKS  — new, marks lapsed memberships expired
//   Expiry reminders  WORKS  — rewritten against the Phase 3 membership domain
//   Auto-renew        DISABLED, deliberately — see runAutoRenew()
//   Class reminders   STILL BROKEN — Phase 12 owns it (V-10)
//
// ── Why the reminders had never fired ───────────────────────────────────────
//
// Not "the tables were empty". The SQL was invalid against the schema. Verified
// against Postgres 16 with the full migration chain applied:
//
//     SELECT ... FROM member_memberships mm JOIN members m ...
//                JOIN plans pl ON pl.id = mm.plan_id
//     ERROR: column mm.plan_id does not exist
//
// `member_memberships` has no plan_id, and the abandoned v3 members table has
// neither `name` nor `deleted_at` — all three of which the query selected or
// filtered on. So every statement raised at plan time, for every organization,
// on every scheduled run, and forEachOrganization() catches per-organization
// failures so one studio's outage cannot stop the rest. That is what had been
// swallowing it.
//
// Stated plainly because it is easy to miss: until this change, NO membership
// expiry or renewal reminder had ever been sent. The notification infrastructure
// underneath was sound; its only caller could not run.
//
// Phase 2 had repointed the three `members` joins at `legacy_members_v3`, since
// migration 166 renamed the abandoned table and put a new canonical one in its
// place — without that they would silently have started addressing the NEW
// table, which is a worse failure because the queries would have looked
// plausible. The reminder sweep now reads the real domain; the class-reminder
// query still reads the legacy table and still cannot run, which is Phase 12's.
//
// ── What was NOT changed, on purpose ────────────────────────────────────────
//
// The per-organization tenant handling. runWithTenantContext plus an explicit
// organization_id filter in every query is the correct pattern and the best
// example of it in the codebase — see the note on forEachOrganization below.
// Phase 3 rewrote the SQL around it and left the tenancy exactly as it was.
//
// Two modes:
//
//   1. BullMQ worker (production): consumes the 'membership-renewals' queue.
//      scheduleRenewalCron() registers two job schedulers (bullmq v6 API):
//        - 'daily-membership-renewal'   cron RENEWAL_CRON       (default 0 3 * * *)
//                                      reminders + auto-renew
//        - 'class-reminder-sweep'       cron RENEWAL_CLASS_CRON (default */30 * * * *)
//                                      class reminders (matches sessions starting
//                                      ~30 min out, so it must run frequently)
//      BullMQ guarantees a scheduled job fires on exactly one worker, so
//      multiple API replicas cannot double-charge.
//
//   2. One-shot script (manual): node src/workers/renewal.worker.js — runs the
//      full daily pass once and exits. Useful for backfills.
//
// In-process: see src/workers/index.js.

const { Worker } = require('bullmq');
const pool = require('../db/pool');
// Tier three (migration 163). Used for exactly one query in this file: the
// enumeration of organizations, which is a platform operation because it is
// what decides which tenant contexts exist. Everything else stays on `pool`.
const platformPool = require('../db/platformPool');
const notifier = require('../modules/notifications/notifications.service');
const razorpay = require('../lib/razorpay');
const logger = require('../lib/logger');
const redis = require('../lib/redis');

const { runWithTenantContext } = require('../lib/tenant-context');

const REMINDER_DAYS = [7, 3, 1];   // send reminder when this many days remain

/**
 * Run `fn(orgId)` once per organization, inside that organization's tenant
 * context.
 *
 * An HTTP request gets its tenant context from the authenticated user, in
 * auth.js. A cron sweep has no user, so until now it had no context either,
 * and its queries simply ran across every tenant at once. That was correct
 * while the application connected as a role that bypasses RLS, and becomes
 * silently wrong the moment it does not: strict policies would match nothing
 * and the sweep would report success having sent no reminders at all.
 *
 * Two things together, not one:
 *
 *  · the tenant context, so RLS resolves for this organization; and
 *  · an explicit organization_id filter in each query.
 *
 * The filter is not redundant. With TENANT_RLS_ENFORCE off the context is
 * inert — pool.js ignores it — so a per-organization loop around unfiltered
 * queries would process every tenant's rows once per organization, sending
 * each member N duplicate reminders. The filter makes the loop correct in
 * both modes, and leaves RLS as the backstop rather than the mechanism.
 *
 * One organization failing must not stop the rest: a Razorpay outage for one
 * studio is not a reason to skip everybody else's reminders, so each is
 * caught and logged individually.
 */
async function forEachOrganization(label, fn) {
  // The platform pool, not the tenant one. This is the query that establishes
  // which tenant contexts exist, so by definition it cannot run inside one.
  //
  // The comment here used to say organizations "carries no organization_id and
  // no policy", and that was true when it was written. Migration 131 then gave
  // every table in public a deny-all policy, and 157 only granted an exception
  // to tables that have an organization_id — which organizations does not. So
  // as app_tenant this returned zero rows and the loop below never ran: every
  // sweep logged "organizations: 0" and did nothing, for every studio, in
  // silence. Measured against the local database: 0 rows as app_tenant, 41 as
  // app_platform.
  //
  // Only the enumeration moves. Each organization's own work stays on the
  // tenant pool inside runWithTenantContext, so RLS remains the backstop for
  // everything that touches a studio's data.
  const { rows: orgs } = await platformPool.query(
    `SELECT id, name FROM organizations WHERE status = 'active' ORDER BY id`
  );
  let ok = 0, failed = 0;
  for (const org of orgs) {
    try {
      await runWithTenantContext(org.id, () => fn(org.id));
      ok++;
    } catch (err) {
      failed++;
      logger.error({ err: err.message, orgId: org.id, task: label },
        'renewal task failed for one organization — continuing with the rest');
    }
  }
  logger.info({ task: label, organizations: orgs.length, ok, failed }, 'renewal sweep complete');
}

async function runReminders() {
  await forEachOrganization('reminders', (orgId) => remindersForOrg(orgId));
}

async function runExpiry() {
  await forEachOrganization('expire-lapsed', (orgId) => expireLapsedForOrg(orgId));
}

async function remindersForOrg(orgId) {
  for (const days of REMINDER_DAYS) {
    // Reads the Phase 3 membership domain (migration 168) joined to the Phase 2
    // canonical member (migration 166).
    //
    // The query this replaced could not run at all. It read `member_memberships`
    // joined to the abandoned v3 members table and to `plans` on `mm.plan_id` —
    // and `member_memberships` has no plan_id, while that members table has
    // neither `name` nor `deleted_at`, all three of which it selected or filtered
    // on. Every statement raised at plan time, for every organization, on every
    // scheduled run, and forEachOrganization's per-organization error handling
    // swallowed it. So no expiry reminder had ever been sent.
    //
    // plan_name comes off the membership rather than the plan table: memberships
    // snapshot what was sold precisely so a renamed or retired plan does not
    // rewrite what the member is told they bought.
    //
    // Served by idx_memberships_expiry (organization_id, status, ends_on).
    const { rows } = await pool.query(`
      SELECT ms.id AS membership_id,
             ms.member_id,
             NULL::text AS user_id,
             m.name, m.email, m.mobile AS phone,
             ms.plan_name,
             ms.ends_on,
             (ms.ends_on - CURRENT_DATE) AS days_remaining
        FROM memberships ms
        JOIN members m ON m.id = ms.member_id
       WHERE ms.status = 'active'
         AND (ms.ends_on - CURRENT_DATE) = $1
         AND ms.deleted_at IS NULL
         AND m.deleted_at IS NULL
         AND ms.organization_id = $2
    `, [days, orgId]);

    for (const m of rows) {
      await notifier.send('membership_expiring', m, { days, plan: m.plan_name },
        ['inapp', 'email', 'whatsapp']);
    }
    logger.info({ count: rows.length, days, orgId }, 'sent expiry reminders');
  }
}

/**
 * Mark memberships whose term has passed as expired.
 *
 * Without this nothing ever leaves 'active', so the reminder sweep above keeps
 * matching lapsed rows and the expiring-soon list grows forever. The routes read
 * status directly, so a stale 'active' is also a member who still appears
 * entitled to walk in.
 *
 * Deliberately does NOT touch 'frozen': a frozen membership's ends_on is pushed
 * out on resume, so expiring it while suspended would take away time the member
 * has paid for. That is the whole point of the freeze.
 */
async function expireLapsedForOrg(orgId) {
  const { rows } = await pool.query(`
    UPDATE memberships
       SET status = 'expired', updated_at = NOW()
     WHERE organization_id = $1
       AND status = 'active'
       AND ends_on < CURRENT_DATE
       AND deleted_at IS NULL
    RETURNING id, member_id, plan_name, ends_on
  `, [orgId]);

  for (const ms of rows) {
    await pool.query(
      `INSERT INTO membership_events
         (organization_id, membership_id, kind, to_ends_on, effective_on, note)
       VALUES ($1, $2, 'expired', $3, CURRENT_DATE, 'Expired by the nightly sweep')`,
      [orgId, ms.id, ms.ends_on]
    );
  }

  if (rows.length) logger.info({ count: rows.length, orgId }, 'expired lapsed memberships');
}

/**
 * Gateway auto-renewal. DISABLED, and left disabled deliberately — see below.
 *
 * Phase 3 rewrote the reminder sweep against the new membership domain because
 * that was a broken thing with an obvious correct form. Auto-renew is not: the
 * `memberships` table has no `auto_renew` flag, and the reason is that giving it
 * one is a product decision rather than a refactor.
 *
 * Charging a stored card without the member initiating it needs a mandate the
 * product does not currently collect, and every payment path that DOES work here
 * is member-initiated: manual UPI with UTR verification, or a Razorpay checkout
 * the member completes. Inventing an auto_renew column and silently charging
 * against it would be the single most consequential thing to guess at in this
 * whole transformation.
 *
 * So this returns immediately, and says why in the log rather than appearing to
 * have run. The body below (autoRenewForOrg) is KEPT rather than deleted: its
 * Razorpay order/capture handling and its gateway_transactions producer — the
 * row the webhook resolves a tenant from, migration 164 — are the parts worth
 * having when Phase 5 designs the billing model, and the comments in it record
 * why each step is shaped the way it is.
 *
 * Note it could not have run before this change either: its SQL referenced
 * mm.auto_renew, mm.plan_id, mm.trainer_id and mm.renewed_from_id, none of which
 * exist on member_memberships. This makes the state explicit instead of relying
 * on a raised exception being swallowed.
 */
async function runAutoRenew() {
  logger.warn({ reason: 'no_mandate_model' },
    'auto-renew is disabled: the membership domain has no auto_renew flag, and '
    + 'charging without a member-initiated mandate is a Phase 5 billing decision. '
    + 'Membership expiry reminders run normally.');
}

/** Kept for Phase 5. Not reachable — see runAutoRenew above. */
// eslint-disable-next-line no-unused-vars
async function autoRenewForOrgDisabled(orgId) {
  return forEachOrganization('auto-renew', (o) => autoRenewForOrg(o));
}

async function autoRenewForOrg(orgId) {
  // Find memberships expiring TODAY with auto_renew=true and gateway available
  const { rows } = await pool.query(`
    SELECT mm.*, m.name, m.email, m.phone, m.user_id, pl.name AS plan_name, pl.duration, pl.price
    FROM member_memberships mm
    JOIN legacy_members_v3 m ON m.id = mm.member_id
    JOIN plans pl ON pl.id = mm.plan_id
    WHERE mm.auto_renew = TRUE
      AND mm.status = 'active'
      AND mm.end_date = CURRENT_DATE
      AND mm.organization_id = $1
  `, [orgId]);

  for (const m of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Charge via Razorpay
      const order = await razorpay.createOrder(m.price * 100, 'INR', `renew_${m.id}_${Date.now()}`);
      const payment = order.status === 'created'
        ? await razorpay.capturePayment(order.id, m.price * 100)
        : null;
      const charge = payment || { id: order.id, status: order.status, amount: m.price };

      // 1b. Record the gateway transaction (migration 164).
      //
      // This is the producer the webhook depends on. gateway_record_event
      // resolves a tenant by finding the row created here; without it a
      // signed, genuine Razorpay event has nothing to attach to and is
      // correctly refused as an unknown payment.
      //
      // orgId is the trusted value from forEachOrganization's platform
      // enumeration, not anything a request supplied. The surrounding
      // transaction already carries app.org_id — pool.connect() injects it on
      // BEGIN inside runWithTenantContext — so this INSERT satisfies the
      // table's strict policy rather than working around it.
      //
      // payment_order_id stays NULL: the renewal flow charges directly and
      // never creates a payment_orders row. The column is nullable in 164 for
      // exactly this case.
      //
      // ON CONFLICT DO NOTHING because a retried sweep must not fail on a
      // charge it already recorded; the unique key is (provider,
      // provider_payment_id).
      await client.query(
        `INSERT INTO gateway_transactions
           (organization_id, provider, provider_payment_id, provider_order_id,
            status, amount, currency)
         VALUES ($1, 'razorpay', $2, $3, $4, $5, 'INR')
         ON CONFLICT (provider, provider_payment_id) DO NOTHING`,
        [orgId, charge.id, order.id,
         charge.status === 'captured' ? 'captured' : 'created', m.price],
      );

      // 2. Create new membership
      const newEnd = new Date();
      newEnd.setDate(newEnd.getDate() + m.duration);

      await client.query(
        `INSERT INTO member_memberships
           (member_id, plan_id, trainer_id, start_date, end_date,
            base_amount, final_amount, paid_amount, auto_renew, renewed_from_id, status)
         VALUES ($1,$2,$3, CURRENT_DATE, $4, $5, $5, $5, TRUE, $6, 'active')`,
        [m.member_id, m.plan_id, m.trainer_id, newEnd, m.price, m.id]
      );

      // 3. Mark old as expired
      await client.query(`UPDATE member_memberships SET status='expired' WHERE id = $1`, [m.id]);

      // 4. Record payment
      await client.query(
        `INSERT INTO payments (member_id, amount, method, date, gateway, gateway_txn_id, gateway_status, branch_id)
         VALUES ($1,$2,'RAZORPAY', CURRENT_DATE, 'razorpay', $3, $4, COALESCE($5, 'br-main'))`,
        [m.member_id, m.price, charge.id, charge.status, process.env.BRANCH_ID || null]
      );

      await client.query('COMMIT');

      // 5. Notify member
      await notifier.send('payment_received', m,
        { amount: m.price, plan: m.plan_name }, ['inapp', 'email', 'whatsapp']);

      logger.info({ member: m.name }, 'auto-renew completed');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ member: m.name, err: err.message }, 'auto-renew failed');
      try {
        await notifier.send('payment_failed', m,
          { amount: m.price, error: err.message }, ['inapp', 'email']);
      } catch (_) { /* best-effort */ }
    } finally {
      client.release();
    }
  }
  logger.info({ count: rows.length, orgId }, 'auto-renew processed');
}

async function runClassReminders() {
  await forEachOrganization('class-reminders', (orgId) => classRemindersForOrg(orgId));
}

async function classRemindersForOrg(orgId) {
  // 30 minutes before each class, ping confirmed members
  const { rows } = await pool.query(`
    SELECT b.id AS booking_id, m.user_id, m.name, m.phone, m.email,
           ct.name AS class_name, TO_CHAR(cs.starts_at, 'HH24:MI') AS time,
           cs.id AS session_id
    FROM bookings b
    JOIN class_sessions cs ON cs.id = b.session_id
    JOIN class_templates ct ON ct.id = cs.template_id
    JOIN legacy_members_v3 m ON m.id = b.member_id
    WHERE b.status = 'confirmed'
      AND cs.starts_at BETWEEN NOW() + INTERVAL '25 minutes' AND NOW() + INTERVAL '35 minutes'
      AND b.organization_id = $1
  `, [orgId]);
  for (const r of rows) {
    await notifier.send('class_reminder', r,
      { class_name: r.class_name, time: r.time }, ['inapp', 'whatsapp', 'push']);
  }
}

/** The full daily pass, shared by the one-shot script and the 'daily' job. */
async function runDailyRenewalTasks() {
  // Expiry BEFORE reminders, deliberately. Reminders match `status = 'active'`
  // on an exact days-remaining value, so sweeping lapsed rows out first stops a
  // membership that ended weeks ago from sitting in the active set — and stops
  // the expiring-soon count growing forever.
  await runExpiry();
  await runReminders();
  await runAutoRenew();
}

/** BullMQ processor for the membership-renewals queue. */
async function processRenewalJob(job) {
  if (job.name === 'daily') {
    await runDailyRenewalTasks();
    return { ran: 'daily' };
  }
  if (job.name === 'class-reminders') {
    await runClassReminders();
    return { ran: 'class-reminders' };
  }
  throw new Error(`Unknown renewal job: ${job.name}`);
}

function createRenewalWorker() {
  const worker = new Worker('membership-renewals', processRenewalJob, {
    connection: redis.getWorkerConnection(),
    prefix: process.env.BULL_PREFIX || 'bull',
    concurrency: 1,
  });

  worker.on('completed', (job) => logger.info({ jobId: job.id, name: job.name }, 'renewal job completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'renewal job failed'));
  worker.on('error', (err) => logger.error({ err: err.message }, 'renewal worker error'));

  return worker;
}

const RENEWAL_JOB_ID = 'daily-membership-renewal';
const CLASS_REMINDER_JOB_ID = 'class-reminder-sweep';

/**
 * Register the renewal job schedulers (bullmq v6 Job Scheduler API — the
 * repeatable-job API was removed in v6, so a scheduler is the supported way to
 * express "run X on a cron"). Idempotent: upserting the same schedulerId
 * updates it rather than creating duplicates, so this is safe to call on every
 * boot and from every replica.
 *
 * Bounded like every other queue call: if Redis is unreachable the upsert
 * would sit in the offline queue forever, so it races a timeout and throws so
 * the caller can log and move on (the workers themselves keep retrying in the
 * background and the scheduler gets registered on a later boot).
 */
async function scheduleRenewalCron() {
  const cron = process.env.RENEWAL_CRON || '0 3 * * *';
  const classCron = process.env.RENEWAL_CLASS_CRON || '*/30 * * * *';

  const { membershipRenewalsQueue } = require('../jobs/queue');

  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('renewal cron schedule timeout')), ms);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);

  await withTimeout(membershipRenewalsQueue.upsertJobScheduler(
    RENEWAL_JOB_ID,
    { pattern: cron },
    {
      name: 'daily',
      data: {},
      opts: {
        // attempts: 1 on purpose — the per-member work is transactional, and a
        // retry of a partially-completed pass risks double-charging. A missed
        // pass is caught by the next day's (or interval's) run.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    }
  ), 5000);

  await withTimeout(membershipRenewalsQueue.upsertJobScheduler(
    CLASS_REMINDER_JOB_ID,
    { pattern: classCron },
    {
      name: 'class-reminders',
      data: {},
      opts: { attempts: 1, removeOnComplete: true, removeOnFail: true },
    }
  ), 5000);

  logger.info({ cron, classCron }, 'renewal cron scheduled');
  return {
    daily: { jobSchedulerId: RENEWAL_JOB_ID },
    classReminders: { jobSchedulerId: CLASS_REMINDER_JOB_ID },
  };
}

async function main() {
  logger.info('worker run starting');
  try {
    await runDailyRenewalTasks();
    await runClassReminders();
  } catch (err) {
    logger.error({ err: err.message }, 'worker run failed');
    process.exitCode = 1;
  }
  process.exit(0);
}

if (require.main === module) {
  // One-shot manual run (historical behavior): --watch keeps the process
  // alive as a worker instead of exiting after a single pass.
  if (process.argv.includes('--watch')) {
    const worker = createRenewalWorker();
    scheduleRenewalCron().catch((err) => logger.error({ err: err.message }, 'renewal cron schedule failed'));
    logger.info('renewal worker started (watch mode)');
    const shutdown = async () => {
      await worker.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    main();
  }
}

module.exports = {
  runReminders, runExpiry, runAutoRenew, runClassReminders, runDailyRenewalTasks,
  createRenewalWorker, scheduleRenewalCron, processRenewalJob,
};
