// Validation for the profile fields added in migration 133.
//
// The recurring rule under test: a malformed ENTRY is dropped, a malformed
// LIST is rejected. Someone who adds a blank row and moves on should not get
// an error dialog; someone POSTing an object where an array belongs has a bug
// worth reporting.
'use strict';

const p = require('../lib/profileFields');

/** Fixed clock, so nothing here depends on the day the suite runs. */
const NOW = new Date('2026-07-29T10:00:00Z');

describe('languages', () => {
  it('de-duplicates case-insensitively and keeps the spelling typed', () => {
    expect(p.validateLanguages(['English', 'english', 'Hindi']).value)
      .toEqual(['English', 'Hindi']);
  });

  it('drops blanks rather than storing empty chips', () => {
    expect(p.validateLanguages(['Tamil', '', '   ', null]).value).toEqual(['Tamil']);
  });

  it('rejects a non-list and caps the length', () => {
    expect(p.validateLanguages('English').error).toMatch(/must be a list/);
    expect(p.validateLanguages(Array.from({ length: 17 }, (_, i) => `L${i}`)).error).toMatch(/more than 15/);
  });
});

describe('coaching modes', () => {
  it('keeps only known modes, de-duplicated', () => {
    expect(p.validateCoachingModes(['online', 'online', 'video']).value).toEqual(['online', 'video']);
  });

  it('DROPS an unknown mode instead of failing the whole save', () => {
    // The set may grow. An older client sending a mode this build has never
    // heard of should still be able to save its name and phone number.
    expect(p.validateCoachingModes(['online', 'telepathy']).value).toEqual(['online']);
  });

  it('returns canonical order, not the order sent', () => {
    // Otherwise the chips move around depending on the order they were ticked.
    expect(p.validateCoachingModes(['video', 'offline', 'online']).value)
      .toEqual(['online', 'offline', 'video']);
  });

  it('still rejects a non-list', () => {
    expect(p.validateCoachingModes({ online: true }).error).toMatch(/must be a list/);
  });
});

describe('previous gyms', () => {
  const ok = { name: 'Iron Temple', role: 'Head Coach', from: '2019-04', to: '2023-08' };

  it('accepts a well-formed entry', () => {
    expect(p.validatePreviousGyms([ok]).value[0]).toMatchObject(ok);
  });

  it('treats an empty end month as "still there"', () => {
    expect(p.validatePreviousGyms([{ ...ok, to: '' }]).value[0].to).toBeNull();
  });

  it('drops a row with no name instead of erroring', () => {
    expect(p.validatePreviousGyms([{ role: 'Coach' }, ok]).value).toHaveLength(1);
  });

  it('rejects a malformed month', () => {
    expect(p.validatePreviousGyms([{ ...ok, from: '2019-13' }]).error).toMatch(/start month/);
    expect(p.validatePreviousGyms([{ ...ok, from: '04-2019' }]).error).toMatch(/start month/);
    expect(p.validatePreviousGyms([{ ...ok, to: 'last year' }]).error).toMatch(/end month/);
  });

  it('rejects leaving before arriving', () => {
    // Stored, it renders as a negative tenure with no clue why.
    expect(p.validatePreviousGyms([{ ...ok, from: '2023-08', to: '2019-04' }]).error)
      .toMatch(/ends before it starts/);
  });

  it('allows starting and leaving in the same month', () => {
    expect(p.validatePreviousGyms([{ ...ok, from: '2020-01', to: '2020-01' }]).error).toBeUndefined();
  });

  it('gives every row a stable id and keeps one that was sent', () => {
    const v = p.validatePreviousGyms([{ name: 'A' }, { name: 'B' }]).value;
    expect(v[0].id).toBeTruthy();
    expect(v[0].id).not.toBe(v[1].id);
    expect(p.validatePreviousGyms([{ ...ok, id: 'keep' }]).value[0].id).toBe('keep');
  });
});

describe('education', () => {
  const ok = { institution: 'IIT Kanpur', degree: 'B.Tech', field: 'Mechanical', year: 2016 };

  it('accepts a well-formed entry', () => {
    expect(p.validateEducation([ok], NOW).value[0]).toMatchObject(ok);
  });

  it('requires only an institution', () => {
    expect(p.validateEducation([{ institution: 'K11 Academy' }], NOW).error).toBeUndefined();
    expect(p.validateEducation([{ degree: 'B.Tech' }], NOW).value).toEqual([]);
  });

  it('allows one year ahead, because a degree can be in progress', () => {
    expect(p.validateEducation([{ ...ok, year: 2027 }], NOW).error).toBeUndefined();
    expect(p.validateEducation([{ ...ok, year: 2028 }], NOW).error).toMatch(/invalid year/);
  });

  it('rejects an implausible or non-integer year', () => {
    expect(p.validateEducation([{ ...ok, year: 1850 }], NOW).error).toMatch(/invalid year/);
    expect(p.validateEducation([{ ...ok, year: 'recently' }], NOW).error).toMatch(/invalid year/);
    expect(p.validateEducation([{ ...ok, year: 2016.5 }], NOW).error).toMatch(/invalid year/);
  });

  it('treats an empty year as simply unset', () => {
    expect(p.validateEducation([{ ...ok, year: '' }], NOW).value[0].year).toBeNull();
  });
});

describe('achievements', () => {
  const ok = { title: 'State Powerlifting Gold', kind: 'competition', issuer: 'UPPA', year: 2023 };

  it('accepts a well-formed entry', () => {
    expect(p.validateAchievements([ok], NOW).value[0]).toMatchObject(ok);
  });

  it('falls back to "other" for an unknown kind rather than failing', () => {
    // The kind only picks an icon. Losing an icon is not worth losing the entry.
    expect(p.validateAchievements([{ ...ok, kind: 'vibes' }], NOW).value[0].kind).toBe('other');
  });

  it('drops a row with no title', () => {
    expect(p.validateAchievements([{ issuer: 'UPPA' }], NOW).value).toEqual([]);
  });

  it('sorts newest first, with undated entries last', () => {
    // A timeline reads from the most recent thing, and an entry with no year
    // has no place in the sequence.
    expect(p.validateAchievements(
      [{ title: 'A', year: 2019 }, { title: 'B', year: 2024 }, { title: 'C' }], NOW,
    ).value.map((x) => x.title)).toEqual(['B', 'A', 'C']);
  });

  it('caps the list', () => {
    expect(p.validateAchievements(Array(41).fill(ok), NOW).error).toMatch(/more than 40/);
  });
});

describe('working hours', () => {
  it('accepts a split shift, which is the normal case in this trade', () => {
    const r = p.validateWorkingHours({ mon: [{ from: '17:00', to: '21:00' }, { from: '06:00', to: '10:00' }] });
    expect(r.value.mon).toEqual([{ from: '06:00', to: '10:00' }, { from: '17:00', to: '21:00' }]);
  });

  it('rejects overlapping ranges on one day', () => {
    // Both cannot be true, and any availability figure built on top would
    // double-count the overlap.
    expect(p.validateWorkingHours({ mon: [{ from: '06:00', to: '12:00' }, { from: '11:00', to: '14:00' }] }).error)
      .toMatch(/overlapping/);
  });

  it('allows one range to start exactly when another ends', () => {
    expect(p.validateWorkingHours({ tue: [{ from: '06:00', to: '10:00' }, { from: '10:00', to: '14:00' }] }).error)
      .toBeUndefined();
  });

  it('rejects a zero-length or reversed range', () => {
    // A zero-length shift means the same as not being there, and stored it
    // renders as a slot somebody could try to book.
    expect(p.validateWorkingHours({ wed: [{ from: '09:00', to: '09:00' }] }).error).toMatch(/ends before it starts/);
    expect(p.validateWorkingHours({ wed: [{ from: '18:00', to: '09:00' }] }).error).toMatch(/ends before it starts/);
  });

  it('rejects a malformed time', () => {
    expect(p.validateWorkingHours({ thu: [{ from: '9am', to: '5pm' }] }).error).toMatch(/HH:MM/);
    expect(p.validateWorkingHours({ thu: [{ from: '25:00', to: '26:00' }] }).error).toMatch(/HH:MM/);
  });

  it('drops an abandoned empty row without erroring', () => {
    expect(p.validateWorkingHours({ fri: [{ from: '', to: '' }] }).value).toEqual({});
  });

  it('ignores unknown day keys', () => {
    expect(p.validateWorkingHours({ someday: [{ from: '06:00', to: '10:00' }] }).value).toEqual({});
  });

  it('rejects an array where an object belongs', () => {
    expect(p.validateWorkingHours([{ from: '06:00', to: '10:00' }]).error).toMatch(/must be an object/);
  });
});

describe('weeklyMinutes', () => {
  it('adds up split shifts across days', () => {
    expect(p.weeklyMinutes({
      mon: [{ from: '06:00', to: '10:00' }],
      tue: [{ from: '17:00', to: '21:30' }],
    })).toBe(510);
  });

  it('is 0 for anything malformed rather than NaN', () => {
    // NaN would render as "NaN hours available" on the profile.
    for (const bad of [null, undefined, 'nope', [], { mon: 'all day' }, { mon: [{ from: 'x', to: 'y' }] }]) {
      expect(p.weeklyMinutes(bad)).toBe(0);
    }
  });
});
