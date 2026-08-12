const { todayIn, today, todayShortDay, appTimeZone, DEFAULT_TIME_ZONE } = require('../lib/appTime');

const AT = (iso) => new Date(iso);

describe('todayIn', () => {
  it('returns the calendar date in the given zone, not UTC', () => {
    // 18:30Z is exactly midnight in IST, so the studio is already on the 8th
    // while UTC is still on the 7th. This is the case that produced the bug:
    // "today's sessions" queried the 7th for the first five and a half hours
    // of the studio's 8th.
    expect(todayIn('Asia/Kolkata', AT('2026-08-07T18:30:00Z'))).toBe('2026-08-08');
    expect(todayIn('UTC', AT('2026-08-07T18:30:00Z'))).toBe('2026-08-07');
  });

  it('rolls over at local midnight, not at 05:30', () => {
    // One minute before IST midnight is still the 7th...
    expect(todayIn('Asia/Kolkata', AT('2026-08-07T18:29:00Z'))).toBe('2026-08-07');
    // ...and one minute after is the 8th. The old UTC-based code did not
    // change until 05:30 IST (00:00Z).
    expect(todayIn('Asia/Kolkata', AT('2026-08-07T18:31:00Z'))).toBe('2026-08-08');
  });

  it('pads month and day to two digits', () => {
    // The value is compared against Postgres DATE output and interpolated into
    // YYYY-MM-DD query params, so a single-digit month would silently match
    // nothing rather than fail loudly.
    expect(todayIn('Asia/Kolkata', AT('2026-01-05T06:00:00Z'))).toBe('2026-01-05');
  });

  it('crosses a year boundary in the studio zone', () => {
    expect(todayIn('Asia/Kolkata', AT('2025-12-31T18:30:00Z'))).toBe('2026-01-01');
  });
});

describe('appTimeZone', () => {
  const original = process.env.APP_TIMEZONE;
  afterEach(() => {
    if (original === undefined) delete process.env.APP_TIMEZONE;
    else process.env.APP_TIMEZONE = original;
  });

  it('defaults to the studio zone when unset', () => {
    delete process.env.APP_TIMEZONE;
    expect(appTimeZone()).toBe(DEFAULT_TIME_ZONE);
  });

  it('honours a valid override', () => {
    process.env.APP_TIMEZONE = 'America/New_York';
    expect(appTimeZone()).toBe('America/New_York');
  });

  it('falls back instead of throwing on a junk zone', () => {
    // A typo in an env var must not become a RangeError on every dashboard
    // request — Intl throws for an unknown zone.
    process.env.APP_TIMEZONE = 'Not/AZone';
    expect(appTimeZone()).toBe(DEFAULT_TIME_ZONE);
    expect(() => today()).not.toThrow();
  });
});

describe('today', () => {
  it('agrees with todayIn under the configured zone', () => {
    const at = AT('2026-08-07T18:30:00Z');
    expect(today(at)).toBe(todayIn(appTimeZone(), at));
  });
});

// ── todayShortDay ──────────────────────────────────────────────────────────
//
// This is a STORAGE format, not a display one. pt_clients.preferred_training_days
// holds what the enrolment form wrote — the keys Mon/Tue/Wed/Thu/Fri/Sat/Sun
// joined with ', ' — and the dashboard matches against that string. A day name
// spelled any other way matches nothing AND FAILS SILENTLY: the roster simply
// comes back empty, which is the exact bug this was added to end.
describe('todayShortDay', () => {
  it('produces the three letters the enrolment form stores', () => {
    // 2026-08-06 is a Thursday. 18:30Z is already Friday in IST, which is the
    // case that would silently roster the wrong day's clients.
    expect(todayShortDay(new Date('2026-08-06T06:00:00Z'))).toBe('Thu');
    expect(todayShortDay(new Date('2026-08-06T18:30:00Z'))).toBe('Fri');
  });

  it('covers every day with exactly the enrolment form\'s spellings', () => {
    // The form's own list, verbatim. If a runtime ever rendered 'Thurs' or
    // 'Thu.' this fails here rather than in a studio's empty dashboard.
    const FORM_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    // 2026-08-03 is a Monday; walk a full week from it, at midday IST so the
    // zone conversion cannot straddle a boundary.
    const got = Array.from({ length: 7 }, (_, i) =>
      todayShortDay(new Date(Date.UTC(2026, 7, 3 + i, 6, 30))));
    expect(got).toEqual(FORM_KEYS);
  });

  it('is a three-letter token, never punctuated or localised', () => {
    expect(todayShortDay(new Date('2026-08-06T06:00:00Z'))).toMatch(/^[A-Z][a-z]{2}$/);
  });
});
