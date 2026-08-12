// Calendar sync is fire-and-forget, so a regression here is silent: bookings
// keep working and the events simply stop appearing. These tests pin the two
// properties that would otherwise fail invisibly — that the sync happens
// AFTER the transaction commits, and that a calendar failure never breaks a
// booking.

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

jest.mock('../db/pool', () => ({
  connect: jest.fn(() => Promise.resolve(mockClient)),
  query: jest.fn(),
}));

jest.mock('../lib/google-calendar', () => ({
  isConfigured: jest.fn(() => true),
  createBookingEvent: jest.fn(() => Promise.resolve()),
  deleteBookingEvent: jest.fn(() => Promise.resolve()),
}));

const pool = require('../db/pool');
const cal = require('../lib/google-calendar');
const bookings = require('../modules/bookings/bookings.service');

/** Let the fire-and-forget promise chain drain. */
const flush = () => new Promise((r) => setImmediate(r));

const SESSION = {
  id: 'sess-1',
  capacity: 10,
  starts_at: new Date(Date.now() + 86400e3).toISOString(),
  status: 'scheduled',
  template_id: 'tpl-1',
};

function bookQueue({ confirmedCount = 0 } = {}) {
  // Mirrors book()'s exact query order: BEGIN, lock session, existing-booking
  // check, membership, confirmed count, [waitlist position], insert, audit,
  // COMMIT.
  const overCapacity = confirmedCount >= SESSION.capacity;
  const calls = [
    {},                                                   // BEGIN
    { rows: [SESSION] },                                  // lock session
    { rows: [] },                                         // no existing booking
    { rows: [{ id: 'mm-1', classes_used: 0, plan_id: 'p1', included_classes: null }] },
    { rows: [{ n: String(confirmedCount) }] },            // confirmed count
  ];
  if (overCapacity) calls.push({ rows: [{ pos: '1' }] });  // waitlist position
  calls.push(
    { rows: [{ id: 'bk-1', status: overCapacity ? 'waitlist' : 'confirmed' }] },
    {},                                                   // audit
    {},                                                   // COMMIT
  );
  mockClient.query.mockReset();
  calls.forEach((r) => mockClient.query.mockResolvedValueOnce(r));
  mockClient.query.mockResolvedValue({ rows: [] });
}

describe('booking → Google Calendar sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [{ id: 'usr-1' }] });
    cal.isConfigured.mockReturnValue(true);
  });

  it('creates the event only after COMMIT', async () => {
    bookQueue();
    await bookings.book({ session_id: 'sess-1', member_id: 'mem-1' }, { user_id: 'usr-9' });
    await flush();

    expect(cal.createBookingEvent).toHaveBeenCalledWith('usr-1', 'bk-1');

    // The session row is locked FOR UPDATE for the whole transaction. Calling
    // Google before COMMIT would hold that lock across a network round-trip
    // and serialise every concurrent booker behind it.
    const committed = mockClient.query.mock.calls.findIndex((c) => c[0] === 'COMMIT');
    expect(committed).toBeGreaterThan(-1);
    expect(mockClient.query.mock.calls.length - 1).toBe(committed);
  });

  it('syncs to the MEMBER, not the admin who made the booking', async () => {
    bookQueue();
    await bookings.book({ session_id: 'sess-1', member_id: 'mem-1' }, { user_id: 'admin-7' });
    await flush();

    // The user lookup must be by member_id — an admin booking on someone's
    // behalf must not get the class in their own diary.
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE member_id = \$1/);
    expect(params).toEqual(['mem-1']);
  });

  it('does not put a waitlist place in anyone diary', async () => {
    bookQueue({ confirmedCount: SESSION.capacity });
    await bookings.book({ session_id: 'sess-1', member_id: 'mem-1' }, { user_id: 'usr-9' });
    await flush();
    expect(cal.createBookingEvent).not.toHaveBeenCalled();
  });

  it('skips entirely when Google Calendar is not configured', async () => {
    cal.isConfigured.mockReturnValue(false);
    bookQueue();
    await bookings.book({ session_id: 'sess-1', member_id: 'mem-1' }, { user_id: 'usr-9' });
    await flush();
    expect(pool.query).not.toHaveBeenCalled();
    expect(cal.createBookingEvent).not.toHaveBeenCalled();
  });

  it('skips a member who has no login', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    bookQueue();
    await bookings.book({ session_id: 'sess-1', member_id: 'mem-1' }, { user_id: 'usr-9' });
    await flush();
    expect(cal.createBookingEvent).not.toHaveBeenCalled();
  });

  it('returns the booking even when the calendar call rejects', async () => {
    // The booking is the product; the calendar entry is a convenience. A
    // Google outage must never cost a member their class.
    cal.createBookingEvent.mockRejectedValueOnce(new Error('google is down'));
    bookQueue();
    const booking = await bookings.book(
      { session_id: 'sess-1', member_id: 'mem-1' }, { user_id: 'usr-9' }
    );
    await flush();
    expect(booking.id).toBe('bk-1');
  });
});
