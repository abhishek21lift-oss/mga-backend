// Readiness — the arithmetic, and the refusals.
//
// This file computes the most dangerous kind of number in the codebase: one
// tidy figure, on a dial, that looks measured and is four opinions a tired
// person gave at the door. Most of what is tested here is therefore not the
// maths but the restraint — that it inverts the readings that need inverting,
// that it will not build a score from one answer, and that it will not call
// three weeks a trend when it has two.

const {
  buildRecovery, readinessOf, readinessBand, sleepScore, WEIGHTS, MIN_INPUTS,
} = require('../modules/pt-os/recovery');

const full = (over = {}) => ({
  week_start_date: '2026-07-27', sleep_hours: 8, stress_level: 1,
  energy_level: 10, soreness_level: 1, ...over,
});

describe('sleepScore', () => {
  it('tops out rather than rewarding more and more sleep', () => {
    expect(sleepScore(7.5)).toBe(100);
    expect(sleepScore(9)).toBe(100);
    expect(sleepScore(12)).toBe(100);
  });

  it('falls off steeply below six, which is where training actually suffers', () => {
    expect(sleepScore(7)).toBe(90);
    expect(sleepScore(6)).toBe(65);
    expect(sleepScore(5)).toBe(45);
    expect(sleepScore(3)).toBe(10);
  });

  it('treats impossible or absent hours as unanswered, not as zero', () => {
    for (const v of [null, undefined, '', 0, -2, 25, 'abc']) expect(sleepScore(v)).toBeNull();
  });
});

describe('readinessOf — direction is the thing to get right', () => {
  it('scores a perfect week at 100', () => {
    expect(readinessOf(full())).toMatchObject({ score: 100, inputs: 4 });
  });

  it('scores the worst possible week near zero', () => {
    const out = readinessOf(full({ sleep_hours: 3, stress_level: 10, energy_level: 1, soreness_level: 10 }));
    expect(out.score).toBeLessThan(10);
  });

  it('INVERTS stress and soreness', () => {
    // Getting this backwards yields a confident, exactly wrong number — a
    // maximally stressed, maximally sore client reading as fully recovered.
    const calm = readinessOf(full({ stress_level: 1, soreness_level: 1 }));
    const wrecked = readinessOf(full({ stress_level: 10, soreness_level: 10 }));
    expect(calm.score).toBeGreaterThan(wrecked.score);
    expect(calm.components.stress).toBe(100);
    expect(wrecked.components.stress).toBe(0);
    expect(wrecked.components.soreness).toBe(0);
  });

  it('does NOT invert energy', () => {
    expect(readinessOf(full({ energy_level: 10 })).components.energy).toBe(100);
    expect(readinessOf(full({ energy_level: 1 })).components.energy).toBe(0);
  });

  it('refuses to build a score from a single answer', () => {
    const one = readinessOf({ sleep_hours: 8 });
    expect(one.score).toBeNull();
    expect(one.inputs).toBe(1);
    expect(MIN_INPUTS).toBe(2);
  });

  it('re-normalises over the answers given rather than counting a blank as zero', () => {
    // An unanswered soreness question is not perfect soreness and not terrible
    // soreness. Two perfect answers must read 100, not 50.
    const partial = readinessOf({ sleep_hours: 8, stress_level: 1 });
    expect(partial.inputs).toBe(2);
    expect(partial.score).toBe(100);
  });

  it('reports how many answers it had, so completeness is never implied', () => {
    expect(readinessOf({ sleep_hours: 8, stress_level: 3, energy_level: 7 }).inputs).toBe(3);
  });

  it('ignores out-of-scale values instead of letting them drag the average', () => {
    const out = readinessOf(full({ stress_level: 75, soreness_level: 0 }));
    expect(out.components.stress).toBeNull();
    expect(out.components.soreness).toBeNull();
    expect(out.inputs).toBe(2);
  });

  it('survives nothing at all', () => {
    expect(readinessOf(null)).toEqual({ score: null, inputs: 0, components: {} });
    expect(readinessOf({})).toMatchObject({ score: null, inputs: 0 });
  });

  it('weights the four equally, and says so', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(new Set(Object.values(WEIGHTS)).size).toBe(1);
  });
});

describe('readinessBand', () => {
  it('gives the number a word', () => {
    expect(readinessBand(92)).toBe('good');
    expect(readinessBand(65)).toBe('fair');
    expect(readinessBand(45)).toBe('low');
    expect(readinessBand(20)).toBe('poor');
    expect(readinessBand(null)).toBeNull();
  });
});

describe('buildRecovery', () => {
  it('is absent when nothing has been recorded', () => {
    expect(buildRecovery([])).toEqual({ present: false, weeks: [] });
    expect(buildRecovery(undefined)).toEqual({ present: false, weeks: [] });
  });

  it('reports the latest week and how complete it was', () => {
    const out = buildRecovery([full({ week_start_date: '2026-07-27' })]);
    expect(out).toMatchObject({ present: true, score: 100, band: 'good', inputs: 4, max_inputs: 4, as_of: '2026-07-27' });
  });

  it('will not call anything a trend on two weeks', () => {
    // "Recovery is declining" is the claim a trainer deloads on. Two points is
    // a line through noise.
    const out = buildRecovery([
      full({ week_start_date: '2026-07-27', stress_level: 9 }),
      full({ week_start_date: '2026-07-20' }),
    ]);
    expect(out.trend).toBeNull();
  });

  it('names a trend once there are three scored weeks', () => {
    const declining = buildRecovery([
      full({ week_start_date: '2026-07-27', sleep_hours: 5, stress_level: 9, energy_level: 2, soreness_level: 9 }),
      full({ week_start_date: '2026-07-20', sleep_hours: 6.5 }),
      full({ week_start_date: '2026-07-13' }),
    ]);
    expect(declining.trend).toBe('declining');

    const steady = buildRecovery([
      full({ week_start_date: '2026-07-27' }),
      full({ week_start_date: '2026-07-20' }),
      full({ week_start_date: '2026-07-13' }),
    ]);
    expect(steady.trend).toBe('steady');
  });

  it('returns the chart series oldest-first, so the caller need not reverse it', () => {
    const out = buildRecovery([
      full({ week_start_date: '2026-07-27' }),
      full({ week_start_date: '2026-07-20' }),
      full({ week_start_date: '2026-07-13' }),
    ]);
    expect(out.weeks.map((w) => w.week)).toEqual(['2026-07-13', '2026-07-20', '2026-07-27']);
  });

  it('keeps unscored weeks out of the chart but still reads the latest one', () => {
    const out = buildRecovery([
      { week_start_date: '2026-07-27', sleep_hours: 8 },   // one answer: no score
      full({ week_start_date: '2026-07-20' }),
    ]);
    expect(out.score).toBeNull();          // the latest week genuinely has none
    expect(out.weeks).toHaveLength(1);     // and it is not plotted
  });

  it('drops rows with no week, which cannot be placed on a timeline', () => {
    expect(buildRecovery([full({ week_start_date: null })])).toEqual({ present: false, weeks: [] });
  });
});
