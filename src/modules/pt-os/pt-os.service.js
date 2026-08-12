const pool = require('../../db/pool');
const { today: studioToday, todayShortDay: studioShortDay } = require('../../lib/appTime');

async function calculateMonthlyCommissions(month) {
  const monthStart = `${month}-01`;
  const mStart = new Date(monthStart + 'T00:00:00Z');
  const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 1);
  const mEndStr = mEnd.toISOString().slice(0, 10);

  const { rows: clients } = await pool.query(`
    SELECT c.id, c.name, c.trainer_id, c.trainer_name,
           c.monthly_pt_amount, c.trainer_commission,
           t.incentive_rate
    FROM pt_clients c
    JOIN pt_trainers t ON t.id = c.trainer_id
    WHERE c.deleted_at IS NULL
      AND c.status IN ('active','frozen')
      AND c.trainer_id IS NOT NULL
      AND c.pt_start_date IS NOT NULL
      AND (c.pt_end_date IS NULL OR NULLIF(c.pt_end_date, '')::DATE >= $1::DATE)
      AND c.pt_start_date <= $2
      AND c.monthly_pt_amount > 0
  `, [mStart.toISOString().slice(0, 10), mEndStr]);

  const results = [];
  for (const cl of clients) {
    const commission = Number(cl.trainer_commission);
    const { rows } = await pool.query(`
      INSERT INTO pt_commissions
        (trainer_id, trainer_name, client_id, client_name,
         month, commission_amt, incentive_rate, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
      ON CONFLICT (trainer_id, client_id, month)
      DO UPDATE SET commission_amt = EXCLUDED.commission_amt,
                    incentive_rate = EXCLUDED.incentive_rate,
                    updated_at = NOW()
      RETURNING *
    `, [
      cl.trainer_id, cl.trainer_name,
      cl.id, cl.name,
      monthStart, commission, cl.incentive_rate,
    ]);
    results.push(rows[0]);
  }
  return { count: results.length, total: results.reduce((s, r) => s + Number(r.commission_amt), 0) };
}

async function getTrainerPayouts(month) {
  const monthStart = `${month}-01`;
  const { rows } = await pool.query(`
    SELECT
      t.id AS trainer_id,
      t.name AS trainer_name,
      COUNT(DISTINCT pc.client_id) AS commission_clients,
      COALESCE(SUM(pc.commission_amt), 0) AS total_commission,
      COALESCE(pp.net_amount, 0) AS paid_amount,
      COALESCE(pp.status, 'pending') AS payout_status,
      pp.id AS payout_id
    FROM pt_trainers t
    LEFT JOIN pt_commissions pc ON pc.trainer_id = t.id AND pc.month = $1
    LEFT JOIN pt_payouts pp ON pp.trainer_id = t.id AND pp.month = $1
    WHERE t.deleted_at IS NULL AND t.status = 'active'
    GROUP BY t.id, t.name, pp.net_amount, pp.status, pp.id
    ORDER BY total_commission DESC
  `, [monthStart]);
  return rows;
}

async function getBalanceSheet(trainerId, scope = {}) {
  const where = [];
  const params = [];
  if (trainerId) {
    params.push(trainerId);
    where.push(`c.trainer_id = $${params.length}`);
  }
  if (scope.applyFilter) {
    params.push(scope.orgId);
    where.push(`c.organization_id = $${params.length}`);
  }
  const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT c.id, c.client_id, c.unique_id, c.name, c.mobile, c.email, c.photo_url,
           c.weight, c.emergency_contact,
           c.trainer_name,
           c.package_type, c.final_amount, c.paid_amount, c.balance_amount,
           c.pt_end_date, (c.pt_end_date - CURRENT_DATE) AS days_left,
           c.status,
           CASE
             WHEN c.balance_amount > 0 AND c.pt_end_date < CURRENT_DATE THEN 'OVERDUE'
             WHEN c.balance_amount > 0 THEN 'DUE'
             ELSE 'CLEAR'
           END AS due_status,
           c.monthly_pt_amount, c.trainer_commission,
           COALESCE(pp.total_incentives, 0) AS total_earned_commission
    FROM pt_clients c
    LEFT JOIN (
      SELECT client_id, SUM(incentive_amt) AS total_incentives
      FROM pt_payments
      WHERE deleted_at IS NULL
      GROUP BY client_id
    ) pp ON pp.client_id = c.id
    WHERE c.deleted_at IS NULL
      ${whereSql}
    ORDER BY c.balance_amount DESC NULLS LAST
  `, params);
  return rows;
}

async function getActiveClients(trainerId, scope = {}) {
  // Returns ALL non-deleted PT clients so the "All Clients" page can show
  // every status. The frontend applies its own status filter on top.
  const where = ['c.deleted_at IS NULL'];
  const params = [];
  if (trainerId) {
    params.push(trainerId);
    where.push(`c.trainer_id = $${params.length}`);
  }
  if (scope.applyFilter) {
    params.push(scope.orgId);
    where.push(`c.organization_id = $${params.length}`);
  }
  const { rows } = await pool.query(`
    SELECT c.id, c.unique_id, c.client_id, c.name, c.gender, c.mobile, c.email,
           c.photo_url, c.dob, c.weight, c.notes, c.address, c.emergency_contact,
           c.trainer_id, c.trainer_name,
           c.package_type, c.base_amount, c.discount, c.final_amount,
           c.paid_amount, c.balance_amount, c.joining_date,
           c.duration_months, c.pt_start_date, c.pt_end_date,
           CASE
             WHEN c.pt_end_date IS NOT NULL AND c.pt_end_date::TEXT != ''
             THEN c.pt_end_date::DATE - CURRENT_DATE
             ELSE NULL
           END AS days_left,
           c.status, c.monthly_pt_amount, c.trainer_commission,
           COALESCE(pp.total_incentives, 0) AS total_earned_commission
    FROM pt_clients c
    LEFT JOIN (
      SELECT client_id, SUM(incentive_amt) AS total_incentives
      FROM pt_payments
      WHERE deleted_at IS NULL
      GROUP BY client_id
    ) pp ON pp.client_id = c.id
    WHERE ${where.join(' AND ')}
    ORDER BY c.name
  `, params);
  return rows;
}

async function getDashboardStats(scope = {}) {
  // Tenant scope: filter every aggregate to the caller's org. $1 (when present)
  // is the org id; bare `organization_id` for single-table queries, aliased
  // `c.organization_id` for the trainer/client join.
  const apply = Boolean(scope.applyFilter);
  const orgParams = apply ? [scope.orgId] : [];
  const orgBare = apply ? ' AND organization_id = $1' : '';
  const orgC = apply ? ' AND c.organization_id = $1' : '';

  const { rows: [totals] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active' AND pt_start_date IS NOT NULL)::INT AS active_pt_clients,
      COUNT(*) FILTER (WHERE status = 'expired')::INT AS expired_clients,
      COUNT(*) FILTER (WHERE balance_amount > 0)::INT AS clients_with_balance,
      -- Owed AND past the end of the package they owe it for. "Pending" and
      -- "overdue" are different sentences to say to somebody on the phone.
      COUNT(*) FILTER (
        WHERE balance_amount > 0
          AND pt_end_date IS NOT NULL
          AND pt_end_date::DATE < CURRENT_DATE
      )::INT AS overdue_clients,
      COALESCE(SUM(trainer_commission) FILTER (WHERE status = 'active' AND pt_start_date IS NOT NULL), 0) AS total_monthly_commission,
      COALESCE(SUM(balance_amount), 0) AS total_outstanding
    FROM pt_clients
    WHERE deleted_at IS NULL${orgBare}
  `, orgParams);

  // ISSUE-005: use actual collected payments (pt_payments) for current-month
  // revenue, not the contracted monthly_pt_amount from pt_clients.
  const { rows: [revenueRow] } = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) AS total_monthly_pt_revenue
    FROM pt_payments
    WHERE date >= date_trunc('month', CURRENT_DATE)
      AND date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      AND deleted_at IS NULL${orgBare}
  `, orgParams);
  totals.total_monthly_pt_revenue = revenueRow.total_monthly_pt_revenue;

  // What actually came in today. Same source as the monthly figure above —
  // pt_payments, the money that was collected — rather than the contracted
  // amounts on pt_clients, which are what was promised.
  const { rows: [todayRow] } = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) AS collected, COUNT(*)::INT AS payments
    FROM pt_payments
    WHERE date = CURRENT_DATE AND deleted_at IS NULL${orgBare}
  `, orgParams);
  totals.today_collected = todayRow.collected;
  totals.today_payments = todayRow.payments;

  const { rows: trainerStats } = await pool.query(`
    SELECT
      t.id, t.name,
      COUNT(c.id) FILTER (WHERE c.status = 'active')::INT AS active_clients,
      COALESCE(SUM(c.monthly_pt_amount) FILTER (WHERE c.status = 'active'), 0) AS monthly_revenue,
      COALESCE(SUM(c.trainer_commission) FILTER (WHERE c.status = 'active'), 0) AS monthly_commission
    FROM pt_trainers t
    LEFT JOIN pt_clients c ON c.trainer_id = t.id AND c.deleted_at IS NULL AND c.pt_start_date IS NOT NULL${orgC}
    WHERE t.deleted_at IS NULL AND t.status = 'active'
    GROUP BY t.id, t.name
    ORDER BY active_clients DESC
  `, orgParams);

  const { rows: revenueTrend } = await pool.query(`
    SELECT
      TO_CHAR(DATE_TRUNC('month', date), 'Mon YYYY') AS label,
      DATE_TRUNC('month', date)::DATE AS month,
      COALESCE(SUM(amount), 0) AS revenue,
      COALESCE(SUM(incentive_amt), 0) AS incentives
    FROM pt_payments
    WHERE date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '5 months')
      AND deleted_at IS NULL${orgBare}
    GROUP BY DATE_TRUNC('month', date)
    ORDER BY month ASC
  `, orgParams);

  return { ...totals, trainers: trainerStats, revenueTrend };
}

async function getCommissionHistory(trainerId) {
  const where = ['c.deleted_at IS NULL'];
  const params = [];
  if (trainerId) {
    params.push(trainerId);
    where.push(`pc.trainer_id = $${params.length}`);
  }
  const { rows } = await pool.query(`
    SELECT pc.*, c.name AS client_name
    FROM pt_commissions pc
    JOIN pt_clients c ON c.id = pc.client_id
    WHERE ${where.join(' AND ')}
    ORDER BY pc.month DESC, pc.client_name
    LIMIT 200
  `, params);
  return rows;
}

async function createPayout(trainerId, month, deductions, processedBy) {
  const monthStart = `${month}-01`;
  const { rows: [commData] } = await pool.query(`
    SELECT
      t.name AS trainer_name,
      COALESCE(SUM(pc.commission_amt), 0) AS total_commission
    FROM pt_trainers t
    LEFT JOIN pt_commissions pc ON pc.trainer_id = t.id AND pc.month = $1
    WHERE t.id = $2 AND t.deleted_at IS NULL
    GROUP BY t.name
  `, [monthStart, trainerId]);

  if (!commData) throw new Error('Trainer not found');

  const totalCommission = Number(commData.total_commission);
  const netAmount = Math.max(0, totalCommission - (deductions || 0));

  const { rows } = await pool.query(`
    INSERT INTO pt_payouts
      (trainer_id, trainer_name, month, total_commission, deductions, net_amount, status, processed_by)
    VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
    ON CONFLICT (trainer_id, month)
    DO UPDATE SET total_commission = EXCLUDED.total_commission,
                  deductions = EXCLUDED.deductions,
                  net_amount = EXCLUDED.net_amount,
                  processed_by = EXCLUDED.processed_by,
                  updated_at = NOW()
    RETURNING *
  `, [trainerId, commData.trainer_name, monthStart, totalCommission, deductions || 0, netAmount, processedBy]);

  return rows[0];
}

async function markPayoutPaid(payoutId, paymentMethod, paymentRef, processedBy) {
  const { rows } = await pool.query(`
    UPDATE pt_payouts
    SET status = 'paid',
        payment_method = COALESCE($2, payment_method),
        payment_ref = COALESCE($3, payment_ref),
        paid_at = NOW(),
        processed_by = COALESCE($4, processed_by),
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [payoutId, paymentMethod, paymentRef, processedBy]);

  if (rows.length > 0) {
    const payout = rows[0];
    await pool.query(`
      UPDATE pt_commissions
      SET status = 'paid', updated_at = NOW()
      WHERE trainer_id = $1 AND month = $2 AND status IN ('pending', 'approved')
    `, [payout.trainer_id, payout.month]);
  }
  return rows[0];
}

/**
 * getOpsSummary — powers the "Today's Operations" and "Session Activity"
 * dashboard sections.  Returns:
 *   today_sessions   — all pt_sessions scheduled/completed today
 *   today_unscheduled— clients whose PROGRAMME prescribes today's weekday
 *   today_enrolled   — clients whose ENROLMENT says they train today
 *   renewals_due     — active clients whose pt_end_date is within 7 days
 *   top_dues         — up to 5 clients with the highest outstanding balance
 *   session_stats    — this-month vs last-month completed session counts
 *   trainer_sessions — per-trainer session totals this month
 */
async function getOpsSummary(scope = {}) {
  // Studio-local, not UTC. `toISOString()` here meant the panel showed
  // yesterday's sessions between midnight and 05:30 IST — see src/lib/appTime.js.
  const today = studioToday();
  const todayDay = studioShortDay();   // 'Mon' … 'Sun', matching the enrolment format
  // Tenant scope: $1 is always `today`; when filtering, $2 is the org id.
  const apply = Boolean(scope.applyFilter);
  const orgS = apply ? ' AND s.organization_id = $2' : '';   // aliased pt_sessions
  const sessParams = apply ? [today, scope.orgId] : [today];
  // For queries whose only param is the org id (bare table, $1).
  const orgBare1 = apply ? ' AND organization_id = $1' : '';
  const bareParams = apply ? [scope.orgId] : [];

  // Today's booked slots, in time order.
  //
  // plan_name comes from the client's ACTIVE assignment, via a LATERAL with
  // LIMIT 1. A plain join would fan a client with two assignments into two
  // rows of the same appointment — the same defect the Today roster had, found
  // there against live data.
  //
  // It is the programme the client is on, not the session's own title. A
  // trainer reading a slot wants to know what they are about to coach, and
  // "PT Session" — which is what title usually holds — does not say.
  const { rows: today_sessions } = await pool.query(`
    SELECT
      s.id, s.title, s.session_date::TEXT, s.start_time::TEXT, s.end_time::TEXT,
      s.status, s.notes,
      c.name  AS client_name,  c.photo_url AS client_photo,
      t.name  AS trainer_name,
      wa.plan_name, wa.plan_id
    FROM pt_sessions s
    LEFT JOIN pt_clients c  ON c.id = s.client_id
    LEFT JOIN pt_trainers t ON t.id = s.trainer_id
    LEFT JOIN LATERAL (
      SELECT wp.name AS plan_name, wp.id AS plan_id
        FROM workout_assignments a
        JOIN workout_plans wp ON wp.id = a.workout_plan_id
       WHERE a.client_id = s.client_id AND a.status = 'active'
       ORDER BY a.start_date DESC
       LIMIT 1
    ) wa ON TRUE
    WHERE s.session_date = $1 AND s.deleted_at IS NULL${orgS}
    ORDER BY COALESCE(s.start_time, '00:00'::TIME)
  `, sessParams);

  // Clients whose PROGRAMME says they train today but who have no booked slot.
  //
  // Without this the section is blank for any studio that runs off programmes
  // rather than the appointment book — which is every studio here today:
  // pt_sessions holds no rows at all while five assignments are active. A
  // "today" panel that can only ever say "nothing scheduled" is worse than no
  // panel, because it teaches the trainer to stop looking at it.
  //
  // day_of_week is ISO (1 = Monday) to match workout_exercises.
  const { rows: today_unscheduled } = await pool.query(`
    SELECT
      a.id AS assignment_id, a.client_id,
      c.name AS client_name, c.photo_url AS client_photo,
      wp.id AS plan_id, wp.name AS plan_name,
      (SELECT COUNT(*) FROM workout_exercises we
        WHERE we.workout_plan_id = wp.id
          AND we.day_of_week = EXTRACT(ISODOW FROM $1::date)::int
          AND we.week_number = 1)::INT AS planned_exercises
    FROM workout_assignments a
    JOIN workout_plans wp ON wp.id = a.workout_plan_id
    JOIN pt_clients   c  ON c.id = a.client_id
   WHERE a.status = 'active'
     AND c.deleted_at IS NULL
     AND EXISTS (
       SELECT 1 FROM workout_exercises we
        WHERE we.workout_plan_id = wp.id
          AND we.day_of_week = EXTRACT(ISODOW FROM $1::date)::int
          AND we.week_number = 1
     )
     AND NOT EXISTS (
       SELECT 1 FROM pt_sessions s
        WHERE s.client_id = a.client_id AND s.session_date = $1 AND s.deleted_at IS NULL
     )
     ${apply ? 'AND a.organization_id = $2' : ''}
   ORDER BY c.name
   LIMIT 25
  `, sessParams);

  // Clients whose ENROLMENT says they train today.
  //
  // The two lists above both assume the studio records its work somewhere the
  // dashboard already looks: an appointment booked into pt_sessions, or a
  // workout plan whose exercises name a weekday. A studio that does neither
  // got "Nothing on today — no booked slots, and no client's programme falls
  // on today" every single day, under a heading naming a day its clients were
  // in fact training on. The panel was not wrong about its own two sources; it
  // was blind to where the answer actually lived.
  //
  // It lives on the client. pt_clients.preferred_training_days is filled at
  // enrolment, where the day picker is a REQUIRED, validated field — so every
  // enrolled client has it — and it is written as the literal string
  // "Mon, Wed, Fri" (the form's `trainingDays.join(', ')`). Until now nothing
  // read it back except the enrolment PDF: the studio was asked which days its
  // client trains, answered, and was then told nobody trains today.
  //
  // Matching strips spaces before splitting so "Mon,Wed" and "Mon, Wed" behave
  // the same, and compares against a three-letter day produced in the studio's
  // own zone (appTime.todayShortDay) rather than the database's locale.
  //
  // The two NOT EXISTS clauses keep a client from appearing twice. A booked
  // slot is more specific than "they usually train Thursdays", and a programme
  // day is more specific than an enrolment preference, so whichever of those
  // exists wins and this list stays the fallback it is meant to be.
  const { rows: today_enrolled } = await pool.query(`
    SELECT
      c.id AS client_id, c.name AS client_name, c.photo_url AS client_photo,
      c.preferred_workout_time, c.preferred_training_days, c.trainer_name
    FROM pt_clients c
   WHERE c.deleted_at IS NULL
     AND c.status = 'active'
     AND c.preferred_training_days IS NOT NULL
     AND $2 = ANY(string_to_array(replace(c.preferred_training_days, ' ', ''), ','))
     AND NOT EXISTS (
       SELECT 1 FROM pt_sessions s
        WHERE s.client_id = c.id AND s.session_date = $1 AND s.deleted_at IS NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM workout_assignments a
         JOIN workout_plans wp ON wp.id = a.workout_plan_id
        WHERE a.client_id = c.id AND a.status = 'active'
          AND EXISTS (
            SELECT 1 FROM workout_exercises we
             WHERE we.workout_plan_id = wp.id
               AND we.day_of_week = EXTRACT(ISODOW FROM $1::date)::int
               AND we.week_number = 1
          )
     )
     ${apply ? 'AND c.organization_id = $3' : ''}
   -- Parsed to a real TIME, not sorted as text. The column is free text
   -- holding two formats: the enrolment dropdown writes '6:00 AM' and its
   -- custom field, an <input type="time">, writes '06:00'. As strings
   -- '1:00 PM' < '5:00 AM', so the afternoon slot sorted before the dawn one.
   -- Anything matching neither shape sorts last rather than corrupting the
   -- order of the rows around it.
   ORDER BY
     CASE
       WHEN c.preferred_workout_time ~* '^[0-9]{1,2}:[0-9]{2}\\s*(AM|PM)$'
         THEN to_timestamp(trim(c.preferred_workout_time), 'HH12:MI AM')::time
       WHEN c.preferred_workout_time ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$'
         THEN c.preferred_workout_time::time
       ELSE NULL
     END NULLS LAST,
     c.name
   LIMIT 25
  `, apply ? [today, todayDay, scope.orgId] : [today, todayDay]);

  const { rows: renewals_due } = await pool.query(`
    SELECT
      id, name, mobile, trainer_name, package_type, photo_url,
      pt_end_date::TEXT,
      (pt_end_date::DATE - CURRENT_DATE)::INT AS days_left,
      balance_amount,
      monthly_pt_amount
    FROM pt_clients
    WHERE deleted_at IS NULL
      AND status = 'active'
      AND pt_end_date IS NOT NULL
      AND pt_end_date::DATE BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'${orgBare1}
    ORDER BY pt_end_date ASC
    LIMIT 15
  `, bareParams);

  const { rows: top_dues } = await pool.query(`
    SELECT
      id, name, mobile, trainer_name, balance_amount, photo_url,
      pt_end_date::TEXT,
      CASE WHEN pt_end_date IS NOT NULL AND pt_end_date::DATE < CURRENT_DATE THEN 'overdue' ELSE 'due' END AS due_status
    FROM pt_clients
    WHERE deleted_at IS NULL AND balance_amount > 0${orgBare1}
    ORDER BY balance_amount DESC
    LIMIT 5
  `, bareParams);

  const { rows: [session_stats] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE session_date >= DATE_TRUNC('month', CURRENT_DATE)
          AND session_date <  DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
      )::INT AS this_month_total,
      COUNT(*) FILTER (
        WHERE session_date >= DATE_TRUNC('month', CURRENT_DATE)
          AND session_date <  DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
          AND status = 'completed'
      )::INT AS this_month_completed,
      COUNT(*) FILTER (
        WHERE session_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
          AND session_date <  DATE_TRUNC('month', CURRENT_DATE)
          AND status = 'completed'
      )::INT AS last_month_completed
    FROM pt_sessions
    WHERE deleted_at IS NULL${orgBare1}
  `, bareParams);

  // Per-trainer totals for the month — scoped, unlike every other query here.
  //
  // This one took no parameters at all: it listed every active trainer on the
  // PLATFORM and their session counts, to every studio that loaded a
  // dashboard. Names of other studios' staff, and how busy they are, is
  // competitive information; it is also the exact class of bug the tenant
  // filter exists to prevent, sitting in the middle of a function where every
  // sibling query was already scoped.
  //
  // Both sides need the filter, for different reasons. On `t` it decides which
  // trainers are listed at all. On `s` it stops a foreign session being
  // COUNTED against a local trainer — the ids are per-table, so a collision is
  // unlikely rather than impossible, and a count is exactly where a stray row
  // would go unnoticed.
  //
  // The `s` filter belongs in the JOIN condition, not the WHERE clause. In the
  // WHERE it would discard the NULL-extended rows a LEFT JOIN produces and
  // silently turn this into an INNER JOIN, dropping every trainer who has no
  // sessions this month — who are precisely the ones a manager is looking for.
  const { rows: trainer_sessions } = await pool.query(`
    SELECT
      t.name AS trainer_name,
      COUNT(s.id) FILTER (WHERE s.status = 'completed')::INT AS completed,
      COUNT(s.id) FILTER (WHERE s.status = 'scheduled')::INT AS scheduled,
      COUNT(s.id) FILTER (WHERE s.status IN ('cancelled','no_show'))::INT AS missed
    FROM pt_trainers t
    LEFT JOIN pt_sessions s
      ON s.trainer_id = t.id
      AND s.session_date >= DATE_TRUNC('month', CURRENT_DATE)
      AND s.session_date <  DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
      AND s.deleted_at IS NULL
      ${apply ? 'AND s.organization_id = $1' : ''}
    WHERE t.deleted_at IS NULL AND t.status = 'active'
      ${apply ? 'AND t.organization_id = $1' : ''}
    GROUP BY t.id, t.name
    ORDER BY completed DESC
  `, bareParams);

  return {
    today_sessions, today_unscheduled, today_enrolled,
    renewals_due, top_dues, session_stats, trainer_sessions,
  };
}

module.exports = {
  calculateMonthlyCommissions,
  getTrainerPayouts,
  getBalanceSheet,
  getActiveClients,
  getDashboardStats,
  getCommissionHistory,
  createPayout,
  markPayoutPaid,
  getOpsSummary,
};
