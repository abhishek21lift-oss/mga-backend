// The client snapshot — what a trainer is told rather than has to remember.
//
// The whole risk in this file is FALSE CONFIDENCE. A coaching prompt built on
// data nobody recorded does not read as a bug; it reads as insight, and it
// gets acted on. So most of what is tested here is silence: that a client with
// no readings produces no claims about their body, and that an absence is
// reported as an absence rather than as a fact.

const {
  buildSnapshot, buildAlerts, buildGoal, buildPrs, buildCoach, weightSeries, daysBetween,
} = require('../modules/pt-os/client-snapshot');

const TODAY = '2026-07-31';
const CLIENT = { id: 'c-1', name: 'Ratnam Yadav', pt_end_date: null, balance_amount: 0 };

const alerts = (over = {}) => buildAlerts({
  client: CLIENT, lifestyle: null, weights: [], lastSession: null, today: TODAY, ...over,
});
const ids = (list) => list.map((a) => a.id);

describe('daysBetween', () => {
  it('counts whole days and survives a timestamp', () => {
    expect(daysBetween('2026-07-01', '2026-07-31')).toBe(30);
    expect(daysBetween('2026-07-31T18:00:00Z', '2026-07-31')).toBe(0);
    expect(daysBetween(null, TODAY)).toBeNull();
    expect(daysBetween('not a date', TODAY)).toBeNull();
  });
});

describe('weightSeries — weight lives in two tables', () => {
  // A studio that only runs fitness tests has an empty measurement table.
  // Reading one source reported "never measured" for a client measured eight
  // times, which would then have raised a false alert.
  it('merges both sources, newest first', () => {
    const s = weightSeries({
      measurements: [{ measured_at: '2026-07-20T10:00:00Z', weight_kg: 79 }],
      assessments: [{ assessment_date: '2026-07-27', weight: 80 }, { assessment_date: '2026-06-01', weight: 84 }],
    });
    expect(s.map((r) => [r.on, r.kg])).toEqual([
      ['2026-07-27', 80], ['2026-07-20', 79], ['2026-06-01', 84],
    ]);
  });

  it('drops rows with no usable weight or date', () => {
    expect(weightSeries({
      assessments: [{ assessment_date: '2026-07-27', weight: null }, { assessment_date: null, weight: 80 }],
      measurements: [{ measured_at: '2026-07-01', weight_kg: 'abc' }],
    })).toEqual([]);
  });
});

describe('alerts — only from a measurement that exists', () => {
  it('says nothing about a client with nothing recorded, except that nothing is recorded', () => {
    // The single permitted alert from an absence, and it is about the RECORD,
    // not about the person.
    expect(ids(alerts())).toEqual(['never_measured']);
  });

  it('raises the PT term as it approaches, and harder once it has passed', () => {
    // 8 days out is worth saying, not worth shouting: inside a fortnight it
    // is a warning, inside a week it is critical, because that is when a
    // renewal conversation actually has to happen.
    expect(alerts({ client: { ...CLIENT, pt_end_date: '2026-08-08' } })
      .find((a) => a.id === 'pt_expiring')).toMatchObject({ severity: 'warning', label: 'PT expires in 8 days' });
    expect(alerts({ client: { ...CLIENT, pt_end_date: '2026-08-05' } })
      .find((a) => a.id === 'pt_expiring')).toMatchObject({ severity: 'critical', label: 'PT expires in 5 days' });
    expect(alerts({ client: { ...CLIENT, pt_end_date: '2026-07-25' } })
      .find((a) => a.id === 'pt_expired')).toMatchObject({ severity: 'critical' });
    // Far enough out is not news.
    expect(ids(alerts({ client: { ...CLIENT, pt_end_date: '2026-12-01' } }))).not.toContain('pt_expiring');
  });

  it('reads money owed from the balance, not from payment rows', () => {
    // Every payment row in the live database says "completed". A studio that
    // has taken no payment at all has no rows — which is the case that matters.
    expect(alerts({ client: { ...CLIENT, balance_amount: 4500 } })
      .find((a) => a.id === 'pending_payment')).toMatchObject({ detail: '₹4,500 outstanding' });
    expect(ids(alerts({ client: { ...CLIENT, balance_amount: 0 } }))).not.toContain('pending_payment');
  });

  it('flags sleep once, from the category or the hours but never both', () => {
    const poor = alerts({ lifestyle: { sleep_category: 'Poor', sleep_duration_hours: 5 } });
    expect(poor.filter((a) => a.id === 'sleep')).toHaveLength(1);
    expect(poor.find((a) => a.id === 'sleep').label).toBe('Sleep poor');
    // A good category with few hours is the studio's own call — respect it.
    expect(ids(alerts({ lifestyle: { sleep_category: 'Excellent', sleep_duration_hours: 5 } })))
      .not.toContain('sleep');
    expect(alerts({ lifestyle: { sleep_duration_hours: 5 } })
      .find((a) => a.id === 'sleep').label).toBe('Sleep short');
  });

  it('reports weight movement as a direction, never as good or bad', () => {
    const a = alerts({ weights: [{ on: '2026-07-27', kg: 78 }, { on: '2026-06-01', kg: 80 }] });
    const w = a.find((x) => x.id === 'weight_change');
    expect(w.label).toBe('Weight down 2 kg');
    expect(w.severity).toBe('info');           // not a warning: it may be the goal
    expect(JSON.stringify(w)).not.toMatch(/good|bad|concern|worry/i);
  });

  it('ignores movement below a kilo — that is a scale, not a trend', () => {
    expect(ids(alerts({ weights: [{ on: '2026-07-27', kg: 80.4 }, { on: '2026-06-01', kg: 80 }] })))
      .not.toContain('weight_change');
  });

  it('describes a stale record as a gap in the record', () => {
    const a = alerts({ weights: [{ on: '2026-06-01', kg: 80 }] });
    const stale = a.find((x) => x.id === 'stale_measurements');
    expect(stale.label).toBe('No measurements in 60 days');
    expect(stale.detail).toContain('2026-06-01');
    // Recently measured is not an alert.
    expect(ids(alerts({ weights: [{ on: '2026-07-20', kg: 80 }] }))).not.toContain('stale_measurements');
  });

  it('only calls a session missed if one was scheduled and not completed', () => {
    expect(ids(alerts({ lastSession: { session_date: '2026-07-28', status: 'in_progress' } })))
      .toContain('missed_workout');
    expect(ids(alerts({ lastSession: { session_date: '2026-07-28', status: 'completed' } })))
      .not.toContain('missed_workout');
    // Nothing booked is not a missed session.
    expect(ids(alerts({ lastSession: null }))).not.toContain('missed_workout');
  });

  it('puts the worst first, because the order is a claim about what to look at', () => {
    const a = alerts({
      client: { ...CLIENT, pt_end_date: '2026-08-02', balance_amount: 1000 },
      lifestyle: { sleep_category: 'Poor' },
      weights: [{ on: '2026-07-20', kg: 80 }, { on: '2026-06-01', kg: 84 }],
    });
    expect(a[0].severity).toBe('critical');
    const ranks = a.map((x) => ({ critical: 0, warning: 1, info: 2 }[x.severity]));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });
});

describe('goal — a bar needs three numbers and only one is stored', () => {
  const GOAL = { priority_goal: 'weight_loss', target_weight: 70, target_date: '2026-10-27', starting_weight: null };

  it('falls back to the earliest weight on file as the start', () => {
    // starting_weight is null on every live row; "where they started" is the
    // first reading anybody took.
    const g = buildGoal({ goal: GOAL, weights: [{ on: '2026-07-27', kg: 73.2 }, { on: '2026-01-02', kg: 80 }] });
    expect(g).toMatchObject({ start_kg: 80, current_kg: 73.2, target_kg: 70, delta_kg: -6.8, remaining_kg: -3.2, pct: 68 });
  });

  it('refuses to invent a denominator', () => {
    // No start means no percentage — a bar drawn against a guessed baseline is
    // worse than no bar, because it looks measured.
    expect(buildGoal({ goal: GOAL, weights: [] })).toMatchObject({ present: true, pct: null });
    expect(buildGoal({ goal: { ...GOAL, target_weight: null }, weights: [{ on: '2026-07-27', kg: 73 }] }).pct).toBeNull();
  });

  it('clamps rather than reporting 140% or a negative', () => {
    expect(buildGoal({ goal: GOAL, weights: [{ on: '2026-07-27', kg: 65 }, { on: '2026-01-02', kg: 80 }] }).pct).toBe(100);
    expect(buildGoal({ goal: GOAL, weights: [{ on: '2026-07-27', kg: 84 }, { on: '2026-01-02', kg: 80 }] }).pct).toBe(0);
  });

  it('is absent when there is no goal', () => {
    expect(buildGoal({ goal: null, weights: [] })).toEqual({ present: false });
  });
});

describe('prs — one row per movement', () => {
  const ROWS = [
    { exercise_name: 'Bench Press', weight_kg: 80, reps: 5, session_date: '2026-07-01' },
    { exercise_name: 'Bench Press', weight_kg: 85, reps: 3, session_date: '2026-07-20' },
    { exercise_name: 'Squat', weight_kg: 120, reps: 5, session_date: '2026-07-10' },
    { exercise_name: '  ', weight_kg: 50, reps: 5, session_date: '2026-07-10' },
    { exercise_name: 'Deadlift', weight_kg: null, reps: 5, session_date: '2026-07-10' },
  ];

  it('keeps the heaviest per exercise, heaviest first', () => {
    expect(buildPrs(ROWS)).toEqual([
      { exercise: 'Squat', weight_kg: 120, reps: 5, achieved_on: '2026-07-10' },
      { exercise: 'Bench Press', weight_kg: 85, reps: 3, achieved_on: '2026-07-20' },
    ]);
  });

  it('drops rows with no name or no weight rather than showing a blank record', () => {
    expect(buildPrs(ROWS).map((p) => p.exercise)).not.toContain('Deadlift');
    expect(buildPrs([]).length).toBe(0);
    expect(buildPrs(undefined).length).toBe(0);
  });
});

describe('coach — derived, never generated', () => {
  it('says nothing at all when nothing is recorded', () => {
    // The most important test here. An empty list renders as "not enough
    // recorded yet", which is true; a generated line would be acted on.
    expect(buildCoach({ lifestyle: null, weights: [], goal: { present: false }, prs: [], alerts: [] })).toEqual([]);
  });

  it('cites the reading behind every line', () => {
    const out = buildCoach({
      lifestyle: { recovery_score: 45 },
      weights: [], goal: { present: false }, prs: [], alerts: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].because).toMatch(/Lifestyle assessment/);
  });

  it('needs three readings before it will call anything a trend', () => {
    const goal = { present: true, pct: 40, target_kg: 70 };
    const two = buildCoach({ weights: [{ kg: 78, on: 'a' }, { kg: 79, on: 'b' }], goal, prs: [], alerts: [] });
    expect(two.find((c) => c.id === 'plateau' || c.id === 'on_track')).toBeUndefined();

    const three = buildCoach({
      weights: [{ kg: 78.9, on: '2026-07-27' }, { kg: 79, on: '2026-07-01' }, { kg: 81, on: '2026-06-01' }],
      goal, prs: [], alerts: [],
    });
    expect(three.find((c) => c.id === 'plateau')).toBeTruthy();
  });

  it('does not raise a plateau for a client who is moving', () => {
    const out = buildCoach({
      weights: [{ kg: 76, on: '2026-07-27' }, { kg: 78, on: '2026-07-01' }, { kg: 79, on: '2026-06-01' }],
      goal: { present: true, pct: 60, target_kg: 70 }, prs: [], alerts: [],
    });
    expect(out.find((c) => c.id === 'plateau')).toBeUndefined();
    expect(out.find((c) => c.id === 'on_track')).toBeTruthy();
  });
});

describe('buildSnapshot', () => {
  it('assembles a client with everything, and nothing without data', () => {
    const snap = buildSnapshot({
      client: { ...CLIENT, pt_end_date: '2026-08-08', balance_amount: 2000 },
      lifestyle: { sleep_category: 'Poor', recovery_score: 50 },
      assessments: [{ assessment_date: '2026-07-27', weight: 73.2 }, { assessment_date: '2026-01-02', weight: 80 }],
      goal: { priority_goal: 'weight_loss', target_weight: 70, target_date: '2026-10-27' },
      prRows: [{ exercise_name: 'Bench Press', weight_kg: 85, reps: 3, session_date: '2026-07-20' }],
      lastSession: { session_date: '2026-07-28', status: 'planned' },
      today: TODAY,
    });
    expect(ids(snap.alerts)).toEqual(expect.arrayContaining(
      ['pt_expiring', 'pending_payment', 'sleep', 'weight_change', 'missed_workout'],
    ));
    expect(snap.goal.pct).toBe(68);
    expect(snap.prs[0].exercise).toBe('Bench Press');
    expect(snap.coach.length).toBeGreaterThan(0);
    expect(snap.baseline_done).toBe(true);
  });

  it('an empty client makes no claims', () => {
    const snap = buildSnapshot({ client: CLIENT, today: TODAY });
    expect(ids(snap.alerts)).toEqual(['never_measured']);
    expect(snap.goal).toEqual({ present: false });
    expect(snap.prs).toEqual([]);
    expect(snap.coach).toEqual([]);
    expect(snap.baseline_done).toBe(false);
  });
});
