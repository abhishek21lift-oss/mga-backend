// Turning logged sets into the four things a trainer actually asks.
//
//   Did they show up?          → adherence
//   Are they getting stronger? → personal records
//   Am I training everything?  → weekly sets per muscle
//   Is anything overcooked?    → sets against the studio's range
//
// Pure functions, no database. The SQL lives with the routes; this is the
// arithmetic, and arithmetic that decides what a trainer tells a client is
// worth testing directly.
//
// ── The rule this file follows ─────────────────────────────────────────────
//
// Every number here is either MEASURED from what was logged, or a range the
// trainer stored. Nothing is estimated, modelled or scored. There is no
// "fatigue score" and no "recovery percentage": those would be numbers with no
// measurement behind them, printed in the same typeface as the ones that do,
// and a trainer would have no way to tell which was which.
//
// What IS shown for recovery is days since a muscle was last trained, which is
// a fact about the log and nothing more.

/** A session counts toward adherence only once it is finished. */
const COMPLETED = 'completed';

/**
 * Monday of the week a date falls in, as YYYY-MM-DD.
 *
 * Weeks are Monday-based to match day_of_week 1 = Monday in workout_exercises.
 * A Sunday-based week would put a Monday session in the previous programme
 * week and make adherence disagree with the plan it is measured against.
 */
function weekStart(date) {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = (d.getUTCDay() + 6) % 7;          // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two dates, or null if either is unusable. */
function daysBetween(from, to) {
  const a = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(to).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.floor((b - a) / 86400000);
}

/**
 * Adherence: sessions done against sessions the programme asked for.
 *
 * `perWeek` is how many days the plan actually prescribes — counted from
 * distinct day_of_week rows, not from sessions_per_week, which is a label a
 * trainer typed and can disagree with the programme underneath it.
 *
 * Only weeks that have STARTED are counted. Including the rest of a twelve-week
 * block would report a client three weeks in as 25% adherent, which reads as a
 * problem when it is just a programme in progress.
 */
function adherence(sessions, { perWeek, startDate, asOf, weeks }) {
  const per = Math.max(0, Math.floor(Number(perWeek) || 0));
  const elapsed = daysBetween(startDate, asOf);
  if (per === 0 || elapsed == null) {
    return { planned: 0, completed: 0, pct: null, weeks: [] };
  }

  // Weeks begun, capped by the plan's length and by the window asked for.
  const begun = Math.min(
    Math.max(1, Math.floor(elapsed / 7) + 1),
    Math.max(1, Math.floor(Number(weeks) || 1)),
  );

  const done = new Map();
  for (const s of sessions) {
    if (s.status !== COMPLETED) continue;
    const w = weekStart(s.session_date);
    if (w) done.set(w, (done.get(w) ?? 0) + 1);
  }

  const rows = [];
  const firstWeek = weekStart(startDate);
  for (let i = 0; i < begun; i++) {
    const d = new Date(`${firstWeek}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i * 7);
    const key = d.toISOString().slice(0, 10);
    // A client who trained four times on a three-day plan is not 133% adherent
    // — the extra session is real, but it does not make up for a missed week,
    // and letting it exceed the target hides exactly that.
    const completed = Math.min(done.get(key) ?? 0, per);
    rows.push({ week_start: key, planned: per, completed, extra: Math.max(0, (done.get(key) ?? 0) - per) });
  }

  const planned = per * begun;
  const completed = rows.reduce((s, r) => s + r.completed, 0);
  return { planned, completed, pct: planned === 0 ? null : Math.round((completed / planned) * 100), weeks: rows };
}

/**
 * Weekly hard sets per muscle, and how long since each was trained.
 *
 * A hard set is a COMPLETED set. Sets that were planned and not performed are
 * not volume, and counting them would tell a trainer their client trained a
 * muscle they skipped.
 *
 * Sets whose exercise has no target_muscle are counted separately rather than
 * dropped. Silently discarding them would understate every muscle by an
 * unknown amount, and the trainer would be reading a chart missing a slice it
 * does not mention.
 */
function muscleWeek(setRows, { asOf, landmarks = new Map() }) {
  const byMuscle = new Map();
  let unattributed = 0;

  for (const r of setRows) {
    const muscle = r.target_muscle;
    if (!muscle) { unattributed += Number(r.sets) || 0; continue; }
    const cur = byMuscle.get(muscle) ?? { target_muscle: muscle, sets: 0, last_trained: null };
    cur.sets += Number(r.sets) || 0;
    if (!cur.last_trained || String(r.last_date) > cur.last_trained) {
      cur.last_trained = String(r.last_date).slice(0, 10);
    }
    byMuscle.set(muscle, cur);
  }

  const rows = [...byMuscle.values()].map((m) => {
    const lm = landmarks.get(m.target_muscle) ?? {};
    const mev = lm.mev_sets ?? null;
    const mrv = lm.mrv_sets ?? null;
    return {
      ...m,
      days_since: m.last_trained ? daysBetween(m.last_trained, asOf) : null,
      mev_sets: mev,
      mrv_sets: mrv,
      // Null, not 'ok', when the studio has no range for this muscle. A
      // default verdict would be a judgement nobody made.
      status: mev == null && mrv == null ? null
        : mev != null && m.sets < mev ? 'below'
          : mrv != null && m.sets > mrv ? 'above'
            : 'within',
    };
  });

  rows.sort((a, b) => b.sets - a.sets || a.target_muscle.localeCompare(b.target_muscle));
  return { muscles: rows, unattributed_sets: unattributed };
}

/**
 * The personal-record timeline.
 *
 * The PR flags are computed at write time against everything logged before, so
 * this only reads them. One entry per set that set a record, newest first —
 * a set can be a weight PR and a volume PR at once, and splitting that into two
 * entries would double-count one moment.
 */
function prTimeline(rows, { limit = 50 } = {}) {
  return rows
    .filter((r) => r.is_pr_weight || r.is_pr_reps || r.is_pr_volume)
    .map((r) => ({
      session_date: String(r.session_date).slice(0, 10),
      exercise_name: r.exercise_name,
      weight_kg: r.weight_kg == null ? null : Number(r.weight_kg),
      reps: r.reps == null ? null : Number(r.reps),
      kinds: [
        r.is_pr_weight ? 'weight' : null,
        r.is_pr_reps ? 'reps' : null,
        r.is_pr_volume ? 'volume' : null,
      ].filter(Boolean),
    }))
    .sort((a, b) => (a.session_date < b.session_date ? 1 : a.session_date > b.session_date ? -1 : 0))
    .slice(0, limit);
}

/**
 * Which prescribed days were missed, and what is still open this week.
 *
 * Deliberately not a recommendation engine. It reports the days the programme
 * asked for that have no completed session, and leaves what to do about it to
 * the trainer — "move leg day to Saturday" depends on the client's week, their
 * knee, and a conversation, none of which is in this database.
 */
function missedDays(plannedDays, sessions, { weekOf, asOf }) {
  const start = weekStart(weekOf);
  if (!start) return { week_start: null, missed: [], remaining: [] };

  const doneDows = new Set();
  for (const s of sessions) {
    if (s.status !== COMPLETED) continue;
    if (weekStart(s.session_date) !== start) continue;
    const d = new Date(`${String(s.session_date).slice(0, 10)}T00:00:00Z`);
    doneDows.add(((d.getUTCDay() + 6) % 7) + 1);        // 1 = Monday
  }

  const todayDow = (() => {
    const d = new Date(`${String(asOf).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? 7 : ((d.getUTCDay() + 6) % 7) + 1;
  })();

  const missed = [];
  const remaining = [];
  for (const dow of plannedDays) {
    if (doneDows.has(dow)) continue;
    // A day still ahead of you is not missed. Calling Friday "missed" on a
    // Tuesday is how an adherence screen teaches a trainer to ignore it.
    (dow < todayDow ? missed : remaining).push(dow);
  }
  return { week_start: start, missed, remaining };
}

module.exports = { weekStart, daysBetween, adherence, muscleWeek, prTimeline, missedDays };
