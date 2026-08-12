// Readiness, from what the client actually said this week.
//
// ── The claim this file makes, and its limits ──────────────────────────────
//
// Four self-reported numbers — sleep, stress, energy, soreness — combined into
// one figure between 0 and 100. That is a real and standard practice in
// strength and conditioning, and it is also the most dangerous kind of number
// in this codebase: a single tidy score, on a coloured dial, that looks
// measured and is in fact four opinions a tired person gave at the door.
//
// So it is built to be argued with:
//
//   · The formula is stated here in full, and the inputs are returned
//     alongside the score. A trainer who thinks soreness is being weighted too
//     heavily can see that it is a quarter of it.
//   · It is computed only from answers that EXIST, and it reports how many it
//     had. Three of four is a different claim from four of four, and one of
//     four is not a recovery score at all — below two inputs it returns null
//     rather than a number built on a single opinion.
//   · There is no HRV here, no sleep staging, no wearable. This is a
//     conversation with a client, quantified. It is labelled as self-reported
//     wherever it is shown.
//
// A trainer who disagrees with the number should trust their eyes. The point
// of the score is to notice a client trending down over five weeks, which eyes
// are bad at, not to overrule a coach who is standing in front of them.

/** Each input is a quarter. Equal weights, because nothing here justifies more. */
const WEIGHTS = { sleep: 0.25, stress: 0.25, energy: 0.25, soreness: 0.25 };

/** Fewer than this many answers is a mood, not a score. */
const MIN_INPUTS = 2;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Clamp a 1–10 self-report; anything outside the scale is treated as absent. */
const scale10 = (v) => {
  const n = num(v);
  return n !== null && n >= 1 && n <= 10 ? n : null;
};

/**
 * Sleep hours → 0-100.
 *
 * Not linear: 8 hours is the target, more than 9 is not better for training
 * readiness, and the penalty below 6 is steep because that is where
 * performance actually falls off. Piecewise rather than a curve, so it can be
 * read and disagreed with.
 */
function sleepScore(hours) {
  const h = num(hours);
  if (h === null || h <= 0 || h > 24) return null;
  if (h >= 7.5) return 100;
  if (h >= 7) return 90;
  if (h >= 6.5) return 78;
  if (h >= 6) return 65;
  if (h >= 5) return 45;
  if (h >= 4) return 25;
  return 10;
}

/**
 * One check-in's readiness.
 *
 * Returns the score, the components it was built from, and how many answers
 * it had — so the caller can say "3 of 4 answered" rather than implying a
 * completeness it does not have.
 */
function readinessOf(checkin) {
  if (!checkin) return { score: null, inputs: 0, components: {} };

  const sleep = sleepScore(checkin.sleep_hours);
  const stress = scale10(checkin.stress_level);
  const energy = scale10(checkin.energy_level);
  const soreness = scale10(checkin.soreness_level);

  const components = {
    // Higher stress and higher soreness are WORSE, so they invert. Getting
    // this backwards would produce a confident, exactly wrong number.
    sleep,
    stress: stress === null ? null : Math.round((10 - stress) * (100 / 9)),
    energy: energy === null ? null : Math.round((energy - 1) * (100 / 9)),
    soreness: soreness === null ? null : Math.round((10 - soreness) * (100 / 9)),
  };

  const present = Object.entries(components).filter(([, v]) => v !== null);
  if (present.length < MIN_INPUTS) {
    return { score: null, inputs: present.length, components };
  }

  // Re-normalise over the answers we have, rather than treating a blank as a
  // zero — an unanswered soreness question is not perfect soreness, and it is
  // not terrible soreness either.
  const totalWeight = present.reduce((s, [k]) => s + WEIGHTS[k], 0);
  const score = present.reduce((s, [k, v]) => s + v * WEIGHTS[k], 0) / totalWeight;

  return { score: Math.round(score), inputs: present.length, components };
}

/** The word that goes with the number. A score with no scale is a decoration. */
function readinessBand(score) {
  if (score === null || score === undefined) return null;
  if (score >= 80) return 'good';
  if (score >= 60) return 'fair';
  if (score >= 40) return 'low';
  return 'poor';
}

/**
 * The recovery picture across recent check-ins.
 *
 * `checkins` newest first. The trend needs three scored weeks: two points is a
 * line through noise, and "recovery is declining" is exactly the claim a
 * trainer will deload on.
 */
function buildRecovery(checkins = []) {
  const rows = (Array.isArray(checkins) ? checkins : [])
    .map((c) => ({
      week: c.week_start_date ? String(c.week_start_date).slice(0, 10) : null,
      mood: c.mood ?? null,
      sleep_hours: num(c.sleep_hours),
      water_glasses: num(c.water_glasses),
      stress_level: scale10(c.stress_level),
      energy_level: scale10(c.energy_level),
      soreness_level: scale10(c.soreness_level),
      ...readinessOf(c),
    }))
    .filter((r) => r.week);

  if (!rows.length) return { present: false, weeks: [] };

  const latest = rows[0];
  const scored = rows.filter((r) => r.score !== null);

  let trend = null;
  if (scored.length >= 3) {
    const recent = scored.slice(0, 3);
    const delta = recent[0].score - recent[recent.length - 1].score;
    trend = Math.abs(delta) < 5 ? 'steady' : delta > 0 ? 'improving' : 'declining';
  }

  return {
    present: true,
    score: latest.score,
    band: readinessBand(latest.score),
    inputs: latest.inputs,
    /** Of four possible. Shown so the score is never read as complete. */
    max_inputs: 4,
    components: latest.components,
    as_of: latest.week,
    trend,
    // Oldest-first for a chart; the caller should not have to reverse it.
    weeks: [...scored].reverse().map((r) => ({ week: r.week, score: r.score })),
    latest,
  };
}

module.exports = {
  buildRecovery, readinessOf, readinessBand, sleepScore, WEIGHTS, MIN_INPUTS,
};
