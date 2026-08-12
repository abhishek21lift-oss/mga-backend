// Resolving what a programme prescribes in a given week.
//
// A programme stores ONE week. Week N's prescription is week 1's with the
// progression rule applied, so a twelve-week block is four rows rather than
// forty-eight day-plans. See migration 137 for why.
//
// Pure functions, no database: the SQL that fetches rows lives with the routes,
// and everything here is arithmetic that can be tested directly.

/** Weeks a plan may run for. Guards against a bad duration turning into a loop. */
const MAX_WEEKS = 104;

/**
 * Which week of a programme a date falls in.
 *
 * Week 1 is the start date's week. Anything before the start is week 1 too —
 * a session logged early is not week zero or week minus one, it is the first
 * week's workout done ahead of time.
 *
 * @returns {number} 1-based week, clamped to [1, MAX_WEEKS]
 */
function weekOf(startDate, onDate) {
  const start = new Date(`${String(startDate).slice(0, 10)}T00:00:00Z`);
  const on = new Date(`${String(onDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(on.getTime())) return 1;
  const days = Math.floor((on - start) / 86400000);
  if (days < 0) return 1;
  return Math.min(MAX_WEEKS, Math.floor(days / 7) + 1);
}

/**
 * How many times the rule has fired by a given week.
 *
 * Week 1 is the baseline — the numbers the trainer typed — so it is always
 * zero steps in. With progression_every_weeks = 2, weeks 1-2 are baseline,
 * weeks 3-4 are one step, and so on.
 */
function stepsFor(week, everyWeeks) {
  const every = Math.max(1, Number(everyWeeks) || 1);
  const w = Math.max(1, Math.floor(Number(week) || 1));
  return Math.floor((w - 1) / every);
}

/**
 * Apply a plan's progression rule to one prescribed exercise.
 *
 * Returns a NEW object; the caller's week-1 row is never mutated, because the
 * same row is resolved once per week when a preview is built.
 *
 * Rules only ever add to a value that exists. Progressing a null target_weight
 * would invent a prescription the trainer never gave — "add 2.5kg" to an
 * exercise with no weight set means nothing, and 2.5kg would be a fabrication.
 */
function applyProgression(exercise, plan, week) {
  const type = plan?.progression_type || 'none';
  const amount = Number(plan?.progression_amount);
  const steps = stepsFor(week, plan?.progression_every_weeks);

  const out = { ...exercise, week_number: week, progression_steps: steps };
  if (type === 'none' || !Number.isFinite(amount) || steps === 0) return out;

  const delta = amount * steps;

  if (type === 'weight') {
    if (exercise.target_weight == null) return out;
    // Round to 0.25 kg: the arithmetic produces 62.50000000000001 and a
    // trainer reads a prescription, not a float.
    out.target_weight = Math.round((Number(exercise.target_weight) + delta) * 4) / 4;
  } else if (type === 'reps') {
    if (exercise.reps == null) return out;
    // Reps are whole. Rounding rather than flooring keeps +0.5/week honest
    // over two weeks instead of losing it every time.
    out.reps = Math.max(1, Math.round(Number(exercise.reps) + delta));
  } else if (type === 'rpe') {
    if (exercise.rpe == null) return out;
    // RPE is a 1-10 scale; past 10 there is nothing left to give, so it caps
    // rather than reporting an 11 that cannot be performed.
    out.rpe = Math.min(10, Math.round((Number(exercise.rpe) + delta) * 10) / 10);
  }

  return out;
}

/**
 * The prescription for one week of a plan.
 *
 * `rows` is every workout_exercises row for the plan and day, across weeks.
 * A row explicitly written for the requested week WINS — that is the override
 * a trainer creates when week 4 should be a deload rather than a step up.
 * Otherwise the week-1 rows are progressed forward.
 *
 * @returns {{ exercises: object[], source: 'override'|'derived' }}
 */
function resolveWeek(rows, plan, week) {
  const w = Math.max(1, Math.floor(Number(week) || 1));
  const overrides = rows.filter((r) => Number(r.week_number) === w);
  if (w !== 1 && overrides.length > 0) {
    return { exercises: overrides.map((r) => ({ ...r, progression_steps: 0 })), source: 'override' };
  }
  const base = rows.filter((r) => Number(r.week_number) === 1);
  return { exercises: base.map((r) => applyProgression(r, plan, w)), source: 'derived' };
}

/**
 * A week-by-week preview of one exercise, for the builder.
 *
 * The point of showing this is that a rule is abstract until you see where it
 * lands: "+2.5 kg/week" over 12 weeks is 60 → 87.5, which a trainer may well
 * decide is too much. Cheaper to see it than to discover it in week 9.
 */
function previewWeeks(exercise, plan, durationWeeks) {
  const weeks = Math.min(MAX_WEEKS, Math.max(1, Number(durationWeeks) || 1));
  return Array.from({ length: weeks }, (_, i) => {
    const resolved = applyProgression(exercise, plan, i + 1);
    return {
      week: i + 1,
      target_weight: resolved.target_weight ?? null,
      reps: resolved.reps ?? null,
      rpe: resolved.rpe ?? null,
    };
  });
}

module.exports = { weekOf, stepsFor, applyProgression, resolveWeek, previewWeeks, MAX_WEEKS };
