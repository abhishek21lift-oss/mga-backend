// Professional credential rules.
//
// The one that matters is expiry. Everything else on a profile is cosmetic if
// it is wrong; a certificate silently reported as current when it lapsed last
// month is the difference between a coach being insured and not.
'use strict';

const c = require('../lib/credentials');

/** Fixed clock, so none of this depends on the day the suite runs. */
const NOW = new Date('2026-07-29T10:00:00Z');
const on = (d) => new Date(`${d}T10:00:00Z`);

describe('certificateStatus', () => {
  it('reports a lapsed certificate as expired, with how long ago', () => {
    expect(c.certificateStatus({ expires_on: '2026-06-29' }, NOW))
      .toEqual({ status: 'expired', daysLeft: -30 });
  });

  it('treats one expiring TODAY as still valid', () => {
    // It lapses tomorrow. Calling it expired would refuse a session the coach
    // is in fact still certified to take.
    expect(c.certificateStatus({ expires_on: '2026-07-29' }, NOW))
      .toEqual({ status: 'expiring', daysLeft: 0 });
  });

  it('flags one inside the renewal window', () => {
    expect(c.certificateStatus({ expires_on: '2026-08-28' }, NOW).status).toBe('expiring');
    expect(c.certificateStatus({ expires_on: '2026-09-27' }, NOW))
      .toEqual({ status: 'expiring', daysLeft: 60 });
  });

  it('leaves one comfortably in date alone', () => {
    expect(c.certificateStatus({ expires_on: '2026-09-28' }, NOW))
      .toEqual({ status: 'valid', daysLeft: 61 });
  });

  it('says UNKNOWN, not valid, when no expiry was recorded', () => {
    // A certificate with no expiry might never expire or might have lapsed
    // years ago. Reporting it as valid is the exact mistake this exists to
    // prevent, so it gets its own status and the UI shows it differently.
    for (const cert of [{}, { expires_on: null }, { expires_on: '' }]) {
      expect(c.certificateStatus(cert, NOW)).toEqual({ status: 'unknown', daysLeft: null });
    }
  });

  it('does not depend on the time of day', () => {
    const early = c.certificateStatus({ expires_on: '2026-07-30' }, new Date('2026-07-29T00:01:00Z'));
    const late = c.certificateStatus({ expires_on: '2026-07-30' }, new Date('2026-07-29T23:59:00Z'));
    expect(early).toEqual(late);
  });

  it('handles a leap day without drifting', () => {
    expect(c.certificateStatus({ expires_on: '2028-02-29' }, on('2028-02-28')).daysLeft).toBe(1);
  });
});

describe('validateCertifications', () => {
  const ok = { name: 'NASM-CPT', issuer: 'NASM', issued_on: '2024-03-01', expires_on: '2026-03-01', credential_id: 'X1' };

  it('accepts a well-formed certificate', () => {
    expect(c.validateCertifications([ok]).value[0]).toMatchObject({
      name: 'NASM-CPT', issuer: 'NASM', issued_on: '2024-03-01', expires_on: '2026-03-01', credential_id: 'X1',
    });
  });

  it('requires a name — everything else is optional', () => {
    expect(c.validateCertifications([{ ...ok, name: '   ' }]).error).toMatch(/needs a name/);
    expect(c.validateCertifications([{ name: 'CPR/AED' }]).error).toBeUndefined();
  });

  it('rejects a date that is not a real day', () => {
    // Date() would roll 31 February into March and store a day nobody entered.
    expect(c.validateCertifications([{ ...ok, expires_on: '2026-02-31' }]).error).toMatch(/expiry date/);
    expect(c.validateCertifications([{ ...ok, issued_on: '01-03-2024' }]).error).toMatch(/issue date/);
    expect(c.validateCertifications([{ ...ok, expires_on: 'soon' }]).error).toMatch(/expiry date/);
  });

  it('rejects an expiry before the issue date', () => {
    // Stored unchallenged it renders as permanently lapsed with no clue why.
    expect(c.validateCertifications([{ ...ok, issued_on: '2026-03-01', expires_on: '2024-03-01' }]).error)
      .toMatch(/expires before it was issued/);
  });

  it('allows issue and expiry on the same day', () => {
    expect(c.validateCertifications([{ ...ok, issued_on: '2026-03-01', expires_on: '2026-03-01' }]).error)
      .toBeUndefined();
  });

  it('gives every certificate a stable id so the UI can key rows', () => {
    const v = c.validateCertifications([{ name: 'A' }, { name: 'B' }]).value;
    expect(v[0].id).toBeTruthy();
    expect(v[0].id).not.toBe(v[1].id);
    expect(c.validateCertifications([{ ...ok, id: 'keep-me' }]).value[0].id).toBe('keep-me');
  });

  it('numbers the error by position, so a long list is fixable', () => {
    expect(c.validateCertifications([ok, ok, { name: '' }]).error).toMatch(/^Certification 3/);
  });

  it('caps the list and rejects a non-list', () => {
    expect(c.validateCertifications(Array(41).fill(ok)).error).toMatch(/more than 40/);
    expect(c.validateCertifications('NASM').error).toMatch(/must be a list/);
    expect(c.validateCertifications(undefined).value).toEqual([]);
  });

  it('collapses whitespace rather than storing ragged input', () => {
    expect(c.validateCertifications([{ name: '  NASM   CPT ' }]).value[0].name).toBe('NASM CPT');
  });
});

describe('validateSpecialisations', () => {
  it('de-duplicates case-insensitively but keeps the spelling typed', () => {
    expect(c.validateSpecialisations(['Strength & Conditioning', 'strength & conditioning', 'Rehab']).value)
      .toEqual(['Strength & Conditioning', 'Rehab']);
  });

  it('drops blanks instead of storing empty chips', () => {
    expect(c.validateSpecialisations(['Yoga', '', '   ', null]).value).toEqual(['Yoga']);
  });

  it('caps the list', () => {
    expect(c.validateSpecialisations(Array.from({ length: 22 }, (_, i) => `S${i}`)).error)
      .toMatch(/more than 20/);
  });
});

describe('yearsOfExperience', () => {
  it('counts whole years', () => {
    expect(c.yearsOfExperience('2018-07-29', NOW)).toBe(8);
    expect(c.yearsOfExperience('2018-07-30', NOW)).toBe(7);
  });

  it('is null for a future date rather than negative', () => {
    expect(c.yearsOfExperience('2030-01-01', NOW)).toBeNull();
  });

  it('is null when unset or malformed', () => {
    expect(c.yearsOfExperience(null, NOW)).toBeNull();
    expect(c.yearsOfExperience('not-a-date', NOW)).toBeNull();
  });
});

describe('credentialSummary', () => {
  it('counts each state separately so the header can lead with the problem', () => {
    expect(c.credentialSummary([
      { name: 'a', expires_on: '2026-06-01' },   // expired
      { name: 'b', expires_on: '2026-08-10' },   // expiring
      { name: 'c', expires_on: '2029-01-01' },   // valid
      { name: 'd' },                             // unknown
    ], NOW)).toEqual({ total: 4, expired: 1, expiring: 1, unknown: 1 });
  });

  it('survives a malformed column without throwing', () => {
    expect(c.credentialSummary(null).total).toBe(0);
    expect(c.credentialSummary('nonsense').total).toBe(0);
  });
});
