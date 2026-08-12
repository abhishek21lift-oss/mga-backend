// What a trainer needs to notice about a client, without remembering it.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// The client profile showed a trainer what had been RECORDED — payments, a
// donut of activity mix, a lifetime total — and left them to work out what it
// meant. Whether a PT term is about to lapse, whether anyone has weighed this
// person in a month, whether last week's session was skipped: all of it was
// derivable from data already on the screen, and none of it was said. So it
// lived in the trainer's head, and the things that fell out of their head are
// exactly the ones that cost a renewal.
//
// ── The rule this file follows ─────────────────────────────────────────────
//
// An alert is only raised from a measurement that exists. There is no default
// severity, no "probably fine", and nothing is inferred from an absence — with
// one deliberate exception, `stale_measurements`, where the absence IS the
// finding and is described as such ("nobody has weighed them since…"), never
// as a fact about the client's body.
//
// This matters more here than in most places. A coaching prompt that fires on
// invented data does not read as a bug; it reads as insight, and it will be
// acted on. A trainer told "weight loss is slowing" for a client nobody has
// measured will change a programme that was working.

const { today: studioToday } = require('../../lib/appTime');

/** Alerts, worst first. Ordering is a claim about what to look at, so it is fixed. */
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const day = (v) => {
  if (!v) return null;
  const s = typeof v === 'string' ? v : v.toISOString?.();
  return s ? String(s).slice(0, 10) : null;
};

/** Whole days from `from` to `to`, or null if either is unusable. */
function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = new Date(`${day(from)}T00:00:00Z`).getTime();
  const b = new Date(`${day(to)}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The weight series, newest first, from whichever table holds it.
 *
 * Weight is written in two places — the measurement log and the fitness test —
 * and a studio that only ever runs assessments has an empty measurement table.
 * Reading one would report "never measured" for a client measured eight times.
 */
function weightSeries({ measurements = [], assessments = [] }) {
  const rows = [
    ...measurements.map((m) => ({ on: day(m.measured_at), kg: num(m.weight_kg), source: 'measurement' })),
    ...assessments.map((a) => ({ on: day(a.assessment_date), kg: num(a.weight), source: 'assessment' })),
  ].filter((r) => r.on && r.kg != null);

  rows.sort((a, b) => (a.on < b.on ? 1 : a.on > b.on ? -1 : 0));
  return rows;
}

/**
 * Every alert the data supports, worst first.
 *
 * `today` is a parameter rather than a call to the clock so that "expires in 8
 * days" is testable and does not change meaning overnight in a test suite.
 */
function buildAlerts({ client, lifestyle, weights, lastSession, today }) {
  const out = [];
  const id = client?.id;
  const push = (a) => out.push(a);

  // ── PT term ──
  // The one with money attached, and the one a trainer finds out about from
  // the client rather than from us.
  const daysLeft = daysBetween(today, client?.pt_end_date);
  if (daysLeft !== null) {
    if (daysLeft < 0) {
      push({
        id: 'pt_expired', severity: 'critical', label: 'PT expired',
        detail: `Ended ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} ago`,
        href: id ? `/pt-os/clients/${id}?renew=1` : null,
      });
    } else if (daysLeft <= 14) {
      push({
        id: 'pt_expiring', severity: daysLeft <= 7 ? 'critical' : 'warning',
        label: `PT expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
        detail: `Ends ${day(client.pt_end_date)}`,
        href: id ? `/pt-os/clients/${id}?renew=1` : null,
      });
    }
  }

  // ── Money owed ──
  // From the client's own balance, not from payment rows: a studio that has
  // taken no payment at all has no rows to read, and that is the case that
  // matters most.
  const balance = num(client?.balance_amount);
  if (balance !== null && balance > 0) {
    push({
      id: 'pending_payment', severity: 'warning', label: 'Pending payment',
      detail: `₹${Math.round(balance).toLocaleString('en-IN')} outstanding`,
      href: id ? `/pt-os/clients/${id}?tab=payments` : null,
    });
  }

  // ── Sleep ──
  // The studio's own category where it was recorded, falling back to hours
  // only when the category is absent. Never both, or one client shows twice.
  if (lifestyle) {
    const cat = typeof lifestyle.sleep_category === 'string' ? lifestyle.sleep_category.toLowerCase() : null;
    const hours = num(lifestyle.sleep_duration_hours);
    if (cat && /poor|bad|very poor/.test(cat)) {
      push({
        id: 'sleep', severity: 'warning', label: 'Sleep poor',
        detail: hours != null ? `${hours} h a night` : 'From the lifestyle assessment',
        href: id ? `/pt-os/lifestyle-assessment?client_id=${id}` : null,
      });
    } else if (!cat && hours != null && hours < 6) {
      push({
        id: 'sleep', severity: 'warning', label: 'Sleep short',
        detail: `${hours} h a night`,
        href: id ? `/pt-os/lifestyle-assessment?client_id=${id}` : null,
      });
    }
  }

  // ── Weight movement ──
  // Reported as a direction and a number, never as good or bad. Whether 2 kg
  // down is progress or a problem depends on the goal, and the goal card next
  // to this one is where that judgement belongs.
  if (weights.length >= 2) {
    const [now, prev] = weights;
    const delta = Math.round((now.kg - prev.kg) * 10) / 10;
    if (Math.abs(delta) >= 1) {
      push({
        id: 'weight_change', severity: 'info',
        label: `Weight ${delta < 0 ? 'down' : 'up'} ${Math.abs(delta)} kg`,
        detail: `${prev.kg} → ${now.kg} kg since ${prev.on}`,
        href: id ? `/pt-os/clients/${id}/training/analytics` : null,
      });
    }
  }

  // ── Nobody has measured them ──
  // The one alert raised BY an absence, and worded as one.
  const lastWeighed = weights[0]?.on ?? null;
  const sinceWeighed = daysBetween(lastWeighed, today);
  if (sinceWeighed !== null && sinceWeighed > 30) {
    push({
      id: 'stale_measurements', severity: 'warning',
      label: `No measurements in ${sinceWeighed} days`,
      detail: `Last recorded ${lastWeighed}`,
      href: id ? `/pt-os/assessment?client_id=${id}` : null,
    });
  } else if (lastWeighed === null) {
    push({
      id: 'never_measured', severity: 'warning', label: 'Never measured',
      detail: 'No weight on file for this client',
      href: id ? `/pt-os/assessment?client_id=${id}` : null,
    });
  }

  // ── Last session ──
  // Only a session that was actually scheduled and not completed. A client
  // with nothing booked has not "missed" anything.
  if (lastSession && lastSession.status && lastSession.status !== 'completed') {
    const ago = daysBetween(lastSession.session_date, today);
    push({
      id: 'missed_workout', severity: 'warning', label: 'Missed last workout',
      detail: [day(lastSession.session_date), ago != null && ago > 0 ? `${ago} days ago` : null]
        .filter(Boolean).join(' · '),
      href: id ? `/pt-os/clients/${id}/workout-log` : null,
    });
  }

  out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return out;
}

/**
 * The goal, as a bar rather than a sentence.
 *
 * Three numbers are needed and only one is reliably stored: the target. The
 * starting weight is null on every row in practice, so it falls back to the
 * EARLIEST weight on file — which is what a trainer means by "where they
 * started" anyway. Without a start there is no denominator, so the card
 * reports the target and the current figure and no percentage, rather than
 * inventing a baseline to divide by.
 */
function buildGoal({ goal, weights }) {
  if (!goal) return { present: false };

  const target = num(goal.target_weight);
  const current = weights[0]?.kg ?? null;
  const start = num(goal.starting_weight) ?? (weights.length ? weights[weights.length - 1].kg : null);

  const base = {
    present: true,
    goal_type: goal.priority_goal ?? goal.goal_type ?? null,
    target_date: day(goal.target_date),
    target_kg: target,
    current_kg: current,
    start_kg: start,
  };

  if (target == null || current == null || start == null || start === target) {
    // Say what is missing, so the card can ask for it rather than show a bar
    // built on a number nobody recorded.
    return { ...base, pct: null, delta_kg: null, remaining_kg: null };
  }

  const moved = current - start;
  const needed = target - start;
  const pct = Math.max(0, Math.min(100, Math.round((moved / needed) * 100)));

  return {
    ...base,
    delta_kg: Math.round(moved * 10) / 10,
    remaining_kg: Math.round((target - current) * 10) / 10,
    pct,
  };
}

/**
 * The best lift on each of the main movements.
 *
 * One row per exercise — a trainer wants "what does their bench look like
 * now", not every set that ever set a record. Heaviest first, because that is
 * the number they will be asked for.
 */
function buildPrs(rows, { limit = 6 } = {}) {
  const best = new Map();
  for (const r of rows ?? []) {
    const name = typeof r.exercise_name === 'string' ? r.exercise_name.trim() : '';
    const kg = num(r.weight_kg);
    if (!name || kg == null) continue;
    const prev = best.get(name);
    if (!prev || kg > prev.weight_kg) {
      best.set(name, {
        exercise: name, weight_kg: kg, reps: num(r.reps), achieved_on: day(r.session_date),
      });
    }
  }
  return [...best.values()].sort((a, b) => b.weight_kg - a.weight_kg).slice(0, limit);
}

/**
 * Coaching prompts, derived — never generated.
 *
 * Each line names the measurement it came from, because a prompt a trainer
 * cannot trace is one they cannot overrule. Nothing is emitted without the
 * reading behind it: no reading, no line, and an empty list is a truthful
 * answer that the card renders as "not enough recorded yet".
 *
 * These are observations with a suggested response, not instructions. The
 * trainer knows things this database does not.
 */
function buildCoach({ lifestyle, weights, goal, prs, alerts }) {
  const out = [];

  // Recovery, from the lifestyle assessment's own score.
  const recovery = num(lifestyle?.recovery_score);
  const risk = typeof lifestyle?.recovery_risk === 'string' ? lifestyle.recovery_risk.toLowerCase() : null;
  if (recovery !== null && recovery < 60) {
    out.push({
      id: 'recovery', tone: 'warn',
      text: `Recovery is scoring ${recovery}/100. Consider trimming accessory volume before touching the main lifts.`,
      because: 'Lifestyle assessment · recovery score',
    });
  } else if (risk && /high|moderate/.test(risk)) {
    out.push({
      id: 'recovery', tone: 'warn',
      text: `Recovery risk is ${lifestyle.recovery_risk.toLowerCase()}. Keep total volume flat this week rather than adding.`,
      because: 'Lifestyle assessment · recovery risk',
    });
  }

  // Rate of change, only with three points — two points are an anecdote.
  if (weights.length >= 3 && goal?.pct != null) {
    const recent = weights[0].kg - weights[1].kg;
    const before = weights[1].kg - weights[2].kg;
    const towards = goal.target_kg != null && goal.target_kg < weights[0].kg ? -1 : 1;
    const movingWell = Math.sign(recent) === towards && Math.abs(recent) >= 0.3;
    if (!movingWell && Math.abs(before) > Math.abs(recent)) {
      out.push({
        id: 'plateau', tone: 'warn',
        text: `Progress toward the goal has slowed — ${Math.abs(Math.round(recent * 10) / 10)} kg this period against ${Math.abs(Math.round(before * 10) / 10)} kg before it.`,
        because: `Weight log · last 3 readings to ${weights[0].on}`,
      });
    } else if (movingWell) {
      out.push({
        id: 'on_track', tone: 'good',
        text: `On track: ${goal.pct}% of the way to ${goal.target_kg} kg.`,
        because: `Weight log · last reading ${weights[0].on}`,
      });
    }
  }

  if (prs.length) {
    const top = prs[0];
    out.push({
      id: 'strength', tone: 'good',
      text: `${top.exercise} is their strongest lift on record at ${top.weight_kg} kg${top.reps ? ` × ${top.reps}` : ''}.`,
      because: `Workout log · ${top.achieved_on}`,
    });
  }

  // Adherence is the one that changes what to do next, so it goes last and
  // reads as a prompt rather than a scolding.
  if (alerts.some((a) => a.id === 'missed_workout')) {
    out.push({
      id: 'adherence', tone: 'warn',
      text: 'A session was missed. Ask what got in the way before adding it back on top of this week.',
      because: 'Workout log · last scheduled session',
    });
  }

  return out;
}

/** Everything the profile needs to stop relying on the trainer's memory. */
function buildSnapshot({
  client, lifestyle, measurements = [], assessments = [], goal,
  prRows = [], lastSession, today = studioToday(),
}) {
  const weights = weightSeries({ measurements, assessments });
  const alerts = buildAlerts({ client, lifestyle, weights, lastSession, today });
  const goalCard = buildGoal({ goal, weights });
  const prs = buildPrs(prRows);
  return {
    alerts,
    goal: goalCard,
    prs,
    coach: buildCoach({ lifestyle, weights, goal: goalCard, prs, alerts }),
    // So the profile can hide "Baseline setup" once it has been done rather
    // than offering it to a client who is already onboarded.
    baseline_done: weights.length > 0 || !!goal,
  };
}

module.exports = {
  buildSnapshot, buildAlerts, buildGoal, buildPrs, buildCoach, weightSeries, daysBetween,
};
