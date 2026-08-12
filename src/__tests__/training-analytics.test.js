// Training analytics: the numbers a trainer repeats back to a client.
//
// These are worth testing carefully for the same reason the progression
// arithmetic is: they are invisible when wrong. "You hit 78% of your sessions"
// is a sentence a client believes, and nothing on the screen would reveal that
// the denominator counted eight weeks the block has not reached yet.

const {
  weekStart, daysBetween, adherence, muscleWeek, prTimeline, missedDays,
} = require('../modules/pt-os/training-analytics');

const done = (d) => ({ session_date: d, status: 'completed' });
const started = (d) => ({ session_date: d, status: 'in_progress' });

describe('weekStart', () => {
  it('anchors weeks to Monday, matching day_of_week 1', () => {
    // 2026-07-29 is a Wednesday.
    expect(weekStart('2026-07-29')).toBe('2026-07-27');
    expect(weekStart('2026-07-27')).toBe('2026-07-27');   // Monday itself
  });

  it('keeps Sunday in the week that began on Monday', () => {
    // A Sunday-based week would push this into the NEXT programme week and
    // make adherence disagree with the plan it is measured against.
    expect(weekStart('2026-08-02')).toBe('2026-07-27');
  });

  it('returns null for an unusable date instead of Invalid Date', () => {
    expect(weekStart('not-a-date')).toBeNull();
  });
});

describe('adherence', () => {
  const base = { perWeek: 3, startDate: '2026-07-06', weeks: 12 };

  it('counts only weeks that have STARTED', () => {
    // Three weeks into a twelve-week block, having done all nine sessions, is
    // 100% — not 25%. Counting the whole block would report a client who has
    // not missed anything as failing.
    const sessions = [
      '2026-07-06', '2026-07-08', '2026-07-10',
      '2026-07-13', '2026-07-15', '2026-07-17',
      '2026-07-20', '2026-07-22', '2026-07-24',
    ].map(done);
    const out = adherence(sessions, { ...base, asOf: '2026-07-24' });
    expect(out.planned).toBe(9);
    expect(out.completed).toBe(9);
    expect(out.pct).toBe(100);
  });

  it('counts a missed week as missed', () => {
    const sessions = ['2026-07-06', '2026-07-08', '2026-07-10'].map(done);
    const out = adherence(sessions, { ...base, asOf: '2026-07-17' });
    expect(out.planned).toBe(6);
    expect(out.completed).toBe(3);
    expect(out.pct).toBe(50);
  });

  it('does not let a bonus session paper over a missed one', () => {
    // Four sessions in week 1 and none in week 2 is not 100% adherence. The
    // extra session is real and reported separately, but it cannot fill a hole
    // in another week — hiding that is exactly what the screen exists to stop.
    const sessions = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-10'].map(done);
    const out = adherence(sessions, { ...base, asOf: '2026-07-17' });
    expect(out.completed).toBe(3);
    expect(out.pct).toBe(50);
    expect(out.weeks[0].extra).toBe(1);
  });

  it('ignores sessions that were started and never finished', () => {
    // An in-progress session is a screen someone opened, not a workout.
    const out = adherence([done('2026-07-06'), started('2026-07-08')], { ...base, asOf: '2026-07-10' });
    expect(out.completed).toBe(1);
  });

  it('reports null rather than 0% when the plan prescribes nothing', () => {
    // 0% reads as a client who never turns up. "No target" is the truth.
    const out = adherence([], { ...base, perWeek: 0, asOf: '2026-07-24' });
    expect(out.pct).toBeNull();
    expect(out.weeks).toHaveLength(0);
  });

  it('survives a missing start date instead of dividing by NaN', () => {
    expect(adherence([], { ...base, startDate: null, asOf: '2026-07-24' }).pct).toBeNull();
  });
});

describe('muscleWeek', () => {
  const rows = [
    { target_muscle: 'chest', sets: 12, last_date: '2026-07-27' },
    { target_muscle: 'hamstrings', sets: 4, last_date: '2026-07-20' },
    { target_muscle: null, sets: 5, last_date: '2026-07-27' },
  ];
  const landmarks = new Map([
    ['chest', { mev_sets: 8, mrv_sets: 22 }],
    ['hamstrings', { mev_sets: 6, mrv_sets: 20 }],
  ]);

  it('reports sets against the studio range', () => {
    const { muscles } = muscleWeek(rows, { asOf: '2026-07-29', landmarks });
    expect(muscles.find((m) => m.target_muscle === 'chest').status).toBe('within');
    expect(muscles.find((m) => m.target_muscle === 'hamstrings').status).toBe('below');
  });

  it('counts sets it cannot attribute rather than dropping them', () => {
    // Silently discarding them would understate every muscle by an unknown
    // amount, on a chart that never mentions the missing slice.
    const { unattributed_sets, muscles } = muscleWeek(rows, { asOf: '2026-07-29', landmarks });
    expect(unattributed_sets).toBe(5);
    expect(muscles.some((m) => m.target_muscle == null)).toBe(false);
  });

  it('passes no verdict where the studio set no range', () => {
    // A default 'ok' would be a coaching judgement nobody made.
    const { muscles } = muscleWeek(
      [{ target_muscle: 'neck', sets: 3, last_date: '2026-07-27' }],
      { asOf: '2026-07-29', landmarks },
    );
    expect(muscles[0].status).toBeNull();
    expect(muscles[0].mev_sets).toBeNull();
  });

  it('reports days since last trained, not a recovery score', () => {
    const { muscles } = muscleWeek(rows, { asOf: '2026-07-29', landmarks });
    expect(muscles.find((m) => m.target_muscle === 'hamstrings').days_since).toBe(9);
    // Nothing here may be a modelled number. If a 'fatigue' or 'recovery' key
    // ever appears, it is an invented value printed beside measured ones.
    for (const m of muscles) {
      expect(Object.keys(m)).not.toContain('fatigue');
      expect(Object.keys(m)).not.toContain('recovery_pct');
    }
  });
});

describe('prTimeline', () => {
  const rows = [
    { session_date: '2026-07-20', exercise_name: 'Squat', weight_kg: 100, reps: 5, is_pr_weight: true, is_pr_reps: false, is_pr_volume: true },
    { session_date: '2026-07-27', exercise_name: 'Bench', weight_kg: 80, reps: 8, is_pr_weight: false, is_pr_reps: true, is_pr_volume: false },
    { session_date: '2026-07-15', exercise_name: 'Row', weight_kg: 60, reps: 10, is_pr_weight: false, is_pr_reps: false, is_pr_volume: false },
  ];

  it('keeps one entry per set, however many records it broke', () => {
    // A set that is both a weight PR and a volume PR is one moment, not two.
    const out = prTimeline(rows);
    expect(out).toHaveLength(2);
    expect(out.find((p) => p.exercise_name === 'Squat').kinds).toEqual(['weight', 'volume']);
  });

  it('puts the newest first', () => {
    expect(prTimeline(rows)[0].exercise_name).toBe('Bench');
  });
});

describe('missedDays', () => {
  // Week of Mon 2026-07-27. Plan trains Mon/Wed/Fri.
  const plan = [1, 3, 5];

  it('does not call a day in the future missed', () => {
    // Calling Friday "missed" on a Wednesday is how a trainer learns to
    // ignore this panel.
    const out = missedDays(plan, [done('2026-07-27')], { weekOf: '2026-07-29', asOf: '2026-07-29' });
    expect(out.missed).toEqual([]);
    expect(out.remaining).toEqual([3, 5]);
  });

  it('reports a day that has passed with nothing logged', () => {
    const out = missedDays(plan, [done('2026-07-27')], { weekOf: '2026-07-31', asOf: '2026-07-31' });
    expect(out.missed).toEqual([3]);
    expect(out.remaining).toEqual([5]);
  });

  it('ignores sessions from a different week', () => {
    // Last Monday's workout does not satisfy this Monday.
    const out = missedDays(plan, [done('2026-07-20')], { weekOf: '2026-07-29', asOf: '2026-07-29' });
    expect(out.missed).toEqual([1]);
  });
});

describe('daysBetween', () => {
  it('is null on a malformed date rather than NaN', () => {
    // NaN would flow into days_since and render as "NaN days ago".
    expect(daysBetween('nope', '2026-07-29')).toBeNull();
  });
});
