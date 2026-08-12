// Progression: resolving what a programme prescribes in week N.
//
// This is the arithmetic behind "author one week, get twelve". It is worth
// testing properly because it is invisible when wrong: a trainer sees a number
// and has no way to tell it is the wrong week's.

const {
  weekOf, stepsFor, applyProgression, resolveWeek, previewWeeks,
} = require('../modules/pt-os/progression');

const PLAN_WEIGHT = { progression_type: 'weight', progression_amount: 2.5, progression_every_weeks: 1 };
const PLAN_NONE = { progression_type: 'none', progression_amount: null, progression_every_weeks: 1 };

const SQUAT = { id: 'e1', name: 'Squat', week_number: 1, day_of_week: 1, sets: 4, reps: 8, target_weight: 60, rpe: 7 };

describe('weekOf', () => {
  it('counts the start date as week 1, not week 0', () => {
    expect(weekOf('2026-07-01', '2026-07-01')).toBe(1);
  });

  it('rolls to week 2 after seven days, not six', () => {
    expect(weekOf('2026-07-01', '2026-07-07')).toBe(1);
    expect(weekOf('2026-07-01', '2026-07-08')).toBe(2);
  });

  it('treats a session logged before the start as week 1', () => {
    // Not week 0 and not negative: a client who trained early did the first
    // week's workout early.
    expect(weekOf('2026-07-10', '2026-07-01')).toBe(1);
  });

  it('survives a malformed date instead of returning NaN', () => {
    // NaN would flow into stepsFor and produce a prescription of NaN kg.
    expect(weekOf('not-a-date', '2026-07-01')).toBe(1);
    expect(weekOf('2026-07-01', undefined)).toBe(1);
  });
});

describe('stepsFor', () => {
  it('is zero in week 1 — the baseline is what the trainer typed', () => {
    expect(stepsFor(1, 1)).toBe(0);
  });

  it('advances every week by default', () => {
    expect(stepsFor(4, 1)).toBe(3);
  });

  it('holds for two weeks at a time when asked to', () => {
    // every=2: weeks 1-2 baseline, weeks 3-4 one step, weeks 5-6 two.
    expect([1, 2, 3, 4, 5, 6].map((w) => stepsFor(w, 2))).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe('applyProgression', () => {
  it('adds weight per step', () => {
    expect(applyProgression(SQUAT, PLAN_WEIGHT, 3).target_weight).toBe(65); // 60 + 2.5*2
  });

  it('leaves the caller row untouched', () => {
    // resolveWeek runs the same base row once per week when building a preview.
    applyProgression(SQUAT, PLAN_WEIGHT, 5);
    expect(SQUAT.target_weight).toBe(60);
  });

  it('does NOT invent a weight where the trainer set none', () => {
    // "Add 2.5kg" to an exercise with no prescribed load is meaningless, and
    // 2.5 would be a number the trainer never wrote.
    const bodyweight = { ...SQUAT, target_weight: null };
    expect(applyProgression(bodyweight, PLAN_WEIGHT, 6).target_weight).toBeNull();
  });

  it('rounds weight to 0.25kg rather than exposing float noise', () => {
    const plan = { ...PLAN_WEIGHT, progression_amount: 0.1 };
    const w = applyProgression({ ...SQUAT, target_weight: 60 }, plan, 4).target_weight;
    expect(Number.isInteger(w * 4)).toBe(true);
  });

  it('keeps reps whole', () => {
    const plan = { progression_type: 'reps', progression_amount: 0.5, progression_every_weeks: 1 };
    expect(applyProgression(SQUAT, plan, 3).reps).toBe(9); // 8 + 0.5*2
    expect(Number.isInteger(applyProgression(SQUAT, plan, 4).reps)).toBe(true);
  });

  it('caps RPE at 10 — there is nothing above it to prescribe', () => {
    const plan = { progression_type: 'rpe', progression_amount: 1, progression_every_weeks: 1 };
    expect(applyProgression(SQUAT, plan, 12).rpe).toBe(10);
  });

  it('changes nothing when the rule is none', () => {
    const out = applyProgression(SQUAT, PLAN_NONE, 9);
    expect(out.target_weight).toBe(60);
    expect(out.reps).toBe(8);
  });

  it('changes nothing in week 1, whatever the rule', () => {
    expect(applyProgression(SQUAT, PLAN_WEIGHT, 1).target_weight).toBe(60);
  });
});

describe('resolveWeek', () => {
  const base = [SQUAT, { ...SQUAT, id: 'e2', name: 'Bench', target_weight: 40 }];

  it('derives a week from the week-1 rows', () => {
    const { exercises, source } = resolveWeek(base, PLAN_WEIGHT, 3);
    expect(source).toBe('derived');
    expect(exercises.map((e) => e.target_weight)).toEqual([65, 45]);
  });

  it('lets an explicit week override the derived numbers', () => {
    // A deload: week 4 written by hand must win over "+2.5kg x3".
    const deload = { ...SQUAT, id: 'e3', week_number: 4, target_weight: 45 };
    const { exercises, source } = resolveWeek([...base, deload], PLAN_WEIGHT, 4);
    expect(source).toBe('override');
    expect(exercises).toHaveLength(1);
    expect(exercises[0].target_weight).toBe(45);
  });

  it('never treats week 1 as an override of itself', () => {
    // Week 1 rows ARE the base. Matching them as overrides would skip
    // progression entirely and silently pin every week to week 1.
    const { source } = resolveWeek(base, PLAN_WEIGHT, 1);
    expect(source).toBe('derived');
  });
});

describe('previewWeeks', () => {
  it('shows where the rule lands, which is the reason to show it', () => {
    const rows = previewWeeks(SQUAT, PLAN_WEIGHT, 12);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ week: 1, target_weight: 60 });
    // 60 + 2.5*11 = 87.5 — a trainer may well decide that is too much, which
    // is cheaper to learn here than in week 9.
    expect(rows[11]).toMatchObject({ week: 12, target_weight: 87.5 });
  });

  it('clamps a nonsense duration instead of looping', () => {
    expect(previewWeeks(SQUAT, PLAN_WEIGHT, 0)).toHaveLength(1);
    expect(previewWeeks(SQUAT, PLAN_WEIGHT, 99999).length).toBeLessThanOrEqual(104);
  });
});
