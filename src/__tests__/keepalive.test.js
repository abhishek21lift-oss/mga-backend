const { resolveKeepalive, isWithinActiveHours, hourIn } = require('../lib/keepalive');

// 2026-07-27T12:00:00Z is 17:30 in Asia/Kolkata (UTC+5:30).
const AT = (iso) => new Date(iso);
const IST = { startHour: 5, endHour: 23, timeZone: 'Asia/Kolkata' };

describe('hourIn', () => {
  it('converts UTC to the target zone', () => {
    expect(hourIn('Asia/Kolkata', AT('2026-07-27T12:00:00Z'))).toBe(17);
    expect(hourIn('UTC', AT('2026-07-27T12:00:00Z'))).toBe(12);
  });

  it('renders midnight as 0, never 24', () => {
    // Guards the ICU h24 quirk the module defends against — a 24 here would
    // silently break every window comparison.
    expect(hourIn('Asia/Kolkata', AT('2026-07-27T18:30:00Z'))).toBe(0);
  });
});

describe('isWithinActiveHours', () => {
  it('is on during studio hours', () => {
    // 17:30 IST
    expect(isWithinActiveHours(AT('2026-07-27T12:00:00Z'), IST)).toBe(true);
  });

  it('is off overnight — the whole point of the window', () => {
    // 02:30 IST — nobody is in the studio, so let it sleep and save the hours.
    expect(isWithinActiveHours(AT('2026-07-27T21:00:00Z'), IST)).toBe(false);
  });

  it('includes the opening hour and excludes the closing hour', () => {
    expect(isWithinActiveHours(AT('2026-07-26T23:30:00Z'), IST)).toBe(true);  // 05:00 IST
    expect(isWithinActiveHours(AT('2026-07-26T22:30:00Z'), IST)).toBe(false); // 04:00 IST
    expect(isWithinActiveHours(AT('2026-07-27T17:30:00Z'), IST)).toBe(false); // 23:00 IST
    expect(isWithinActiveHours(AT('2026-07-27T16:30:00Z'), IST)).toBe(true);  // 22:00 IST
  });

  it('handles a window that wraps past midnight', () => {
    const night = { startHour: 22, endHour: 6, timeZone: 'UTC' };
    expect(isWithinActiveHours(AT('2026-07-27T23:00:00Z'), night)).toBe(true);
    expect(isWithinActiveHours(AT('2026-07-27T02:00:00Z'), night)).toBe(true);
    expect(isWithinActiveHours(AT('2026-07-27T07:00:00Z'), night)).toBe(false);
  });

  it('treats start === end as always on', () => {
    const always = { startHour: 0, endHour: 0, timeZone: 'UTC' };
    expect(isWithinActiveHours(AT('2026-07-27T03:00:00Z'), always)).toBe(true);
  });
});

describe('resolveKeepalive', () => {
  it('derives the public health URL from RENDER_EXTERNAL_URL', () => {
    const ka = resolveKeepalive({ RENDER_EXTERNAL_URL: 'https://api.example.com' });
    expect(ka.url).toBe('https://api.example.com/api/health');
  });

  it('does not double the slash on a trailing-slash base', () => {
    const ka = resolveKeepalive({ RENDER_EXTERNAL_URL: 'https://api.example.com/' });
    expect(ka.url).toBe('https://api.example.com/api/health');
  });

  it('lets an explicit KEEPALIVE_URL win', () => {
    const ka = resolveKeepalive({
      KEEPALIVE_URL: 'https://custom.example.com/ping',
      RENDER_EXTERNAL_URL: 'https://api.example.com',
    });
    expect(ka.url).toBe('https://custom.example.com/ping');
  });

  it('returns no url rather than falling back to localhost', () => {
    // Pinging localhost is the exact bug this replaced: it looks like it works
    // and the service sleeps anyway. A null url makes the caller log loudly.
    expect(resolveKeepalive({}).url).toBeNull();
  });

  it('reads the window from env and ignores junk', () => {
    expect(resolveKeepalive({ KEEPALIVE_START_HOUR: '7', KEEPALIVE_END_HOUR: '21' }))
      .toMatchObject({ startHour: 7, endHour: 21 });
    expect(resolveKeepalive({ KEEPALIVE_START_HOUR: 'nonsense', KEEPALIVE_END_HOUR: '99' }))
      .toMatchObject({ startHour: 5, endHour: 23 });
  });
});
