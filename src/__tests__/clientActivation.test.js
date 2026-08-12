// The client activation link: who may be given one, and what a token is worth.
//
// Two separate concerns, both here because both decide whether an account gets
// created that should not have.
//
//   eligibility() is the product rule — a login is what somebody gets for
//   having paid — and it is the only implementation of that rule. The trainer's
//   button reads its answer, and the route re-checks it server-side.
//
//   resolve() is the security rule. The token is the sole credential on an
//   unauthenticated write surface, so "expired", "already used" and "never
//   existed" must be indistinguishable to anyone probing.

const crypto = require('crypto');

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

const pool = require('../db/pool');
const invites = require('../lib/clientInvitations');
const { validatePassword } = require('../routes/invitations');

const paidClient = (over = {}) => ({
  id: 'ptc-1', name: 'Hari Narayan Singh', email: 'hari@example.com',
  paid_amount: '5000.00', balance_amount: '0.00',
  login_activated: false, deleted_at: null, ...over,
});

describe('who may be given a login', () => {
  it('allows a client who has paid and has an email', () => {
    expect(invites.eligibility(paidClient()).ok).toBe(true);
  });

  it('refuses a client who has paid nothing', () => {
    // The rule the whole feature exists for: access follows payment.
    const out = invites.eligibility(paidClient({ paid_amount: '0.00' }));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('unpaid');
  });

  it('allows a client part-way through an instalment plan', () => {
    // Deliberately paid_amount > 0 and NOT balance_amount <= 0. Requiring a
    // clear balance would lock out every client on instalments, which is most
    // of them — they have paid, so they get in.
    const out = invites.eligibility(paidClient({ paid_amount: '2000.00', balance_amount: '3000.00' }));
    expect(out.ok).toBe(true);
  });

  it('refuses a client with no email, or a malformed one', () => {
    for (const email of [null, '', '   ', 'not-an-email', 'a@b', 'a@b.']) {
      const out = invites.eligibility(paidClient({ email }));
      expect([email, out.ok, out.reason]).toEqual([email, false, 'no_email']);
    }
  });

  it('refuses a client who already has a login', () => {
    // Activate must not be a way to silently reset somebody's password.
    // Re-issuing goes through Resend, which is explicit about what it does.
    const out = invites.eligibility(paidClient({ login_activated: true }));
    expect(out.reason).toBe('already_active');
  });

  it('refuses a deleted client', () => {
    const out = invites.eligibility(paidClient({ deleted_at: new Date().toISOString() }));
    expect(out.reason).toBe('deleted');
  });

  it('refuses a missing client rather than throwing', () => {
    // Called with whatever the lookup returned, which is undefined for an id
    // that is not in this studio. A throw here would be a 500 on a routine
    // 404.
    expect(invites.eligibility(undefined).reason).toBe('not_found');
    expect(invites.eligibility(null).reason).toBe('not_found');
  });

  it('gives every refusal a message a trainer can act on', () => {
    for (const c of [
      paidClient({ paid_amount: 0 }), paidClient({ email: null }),
      paidClient({ login_activated: true }), undefined,
    ]) {
      const out = invites.eligibility(c);
      expect(out.ok).toBe(false);
      expect(typeof out.message).toBe('string');
      expect(out.message.length).toBeGreaterThan(10);
    }
  });
});

describe('what a token is worth', () => {
  const RAW = crypto.randomBytes(32).toString('hex');
  const future = () => new Date(Date.now() + 3600_000).toISOString();
  const past = () => new Date(Date.now() - 3600_000).toISOString();

  beforeEach(() => pool.query.mockReset());

  it('stores only the hash, never the token', async () => {
    // The raw value goes in the email and nowhere else. A database dump must
    // not be a set of working activation links.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'inv-1' }] });
    const { token } = await invites.create({
      userId: 'usr-1', ptClientId: 'ptc-1', organizationId: 'org-a', email: 'a@b.com',
    });
    const [, params] = pool.query.mock.calls[0];
    expect(params).not.toContain(token);
    expect(params).toContain(invites.hashToken(token));
  });

  it('looks a token up by its hash', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'inv-1', status: 'sent', expires_at: future() }] });
    await invites.resolve(RAW);
    const [, params] = pool.query.mock.calls[0];
    expect(params[0]).toBe(invites.hashToken(RAW));
    expect(params[0]).not.toBe(RAW);
  });

  it('accepts a live token', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'inv-1', status: 'sent', expires_at: future() }] });
    expect((await invites.resolve(RAW)).ok).toBe(true);
  });

  it('refuses an expired token even though the row still says sent', async () => {
    // Expiry is a function of the clock, not of a stored status. A link that
    // lapsed overnight is still 'sent' in the table until something touches
    // it, and there is no sweep job.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'inv-1', status: 'sent', expires_at: past() }] });
    const out = await invites.resolve(RAW);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('expired');
  });

  it('refuses a token that has already been used', async () => {
    // Single-use is what stops a forwarded email from letting a second person
    // set the password on a live account.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'inv-1', status: 'activated', expires_at: future() }] });
    expect((await invites.resolve(RAW)).reason).toBe('used');
  });

  it('refuses a superseded token', async () => {
    // Resend cancels the previous link. Without that, "resend because the
    // first may have been intercepted" leaves the intercepted link working.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'inv-1', status: 'cancelled', expires_at: future() }] });
    expect((await invites.resolve(RAW)).reason).toBe('cancelled');
  });

  it('rejects a short or absent token without touching the database', async () => {
    // A guessing loop must not each time cost a query.
    for (const bad of [null, undefined, '', 'abc', 123, {}]) {
      const out = await invites.resolve(bad);
      expect(out).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('does not resolve an activated token to ok just because it has not expired', async () => {
    // Ordering check: terminal status is read before the clock. Reversed, a
    // used-but-unexpired link would work a second time.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'i', status: 'activated', expires_at: future() }] });
    expect((await invites.resolve(RAW)).ok).toBe(false);
  });

  it('keeps an activated invitation activated after its expiry passes', async () => {
    // The reverse ordering error: an account that onboarded last week must not
    // start reporting 'expired', which would rewrite history to say the client
    // never activated.
    expect(invites.effectiveStatus({ status: 'activated', expires_at: past() })).toBe('activated');
    expect(invites.effectiveStatus({ status: 'cancelled', expires_at: past() })).toBe('cancelled');
  });
});

describe('the password rule', () => {
  it('is the same rule the admin flow enforces', () => {
    // Imported from routes/invitations rather than reimplemented. Two copies
    // of a password policy is how one of them ends up being the weak one.
    expect(validatePassword('Str0ng!pass')).toBeNull();
  });

  it('rejects everything the spec says it must', () => {
    const cases = [
      ['Ab1!def', 'too short'],
      ['alllower1!', 'no uppercase'],
      ['ALLUPPER1!', 'no lowercase'],
      ['NoDigits!!', 'no number'],
      ['NoSpecial12', 'no special character'],
      ['', 'empty'],
    ];
    for (const [pw, why] of cases) {
      expect([why, validatePassword(pw) === null]).toEqual([why, false]);
    }
  });

  it('rejects an absurdly long password rather than hashing it', () => {
    // bcrypt on a multi-megabyte input is a free CPU-exhaustion primitive on
    // an unauthenticated endpoint.
    expect(validatePassword('A1!a'.repeat(1000))).toBeTruthy();
  });
});

describe('resend rate limiting', () => {
  beforeEach(() => pool.query.mockReset());

  it('counts rows in the window rather than an in-memory tally', async () => {
    // The API runs more than one instance and restarts on every deploy. A
    // per-process counter multiplies the real allowance by the instance count
    // and hands out a fresh budget exactly when somebody is hammering it.
    pool.query.mockResolvedValueOnce({ rows: [{ n: 1 }] });
    const out = await invites.withinRateLimit('ptc-1');
    expect(out.ok).toBe(true);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/count\(\*\)/i);
    expect(sql).toMatch(/client_invitations/);
    expect(params[0]).toBe('ptc-1');
  });

  it('refuses once the window is full', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ n: invites.RATE_LIMIT_MAX }] });
    expect((await invites.withinRateLimit('ptc-1')).ok).toBe(false);
  });

  it('is scoped per client, so one client cannot exhaust another’s allowance', async () => {
    // Both halves, because passing the id as a parameter proves nothing on its
    // own — an earlier version of this test checked only that, and a mutation
    // replacing the WHERE clause with `($1 IS NOT NULL)` sailed through it
    // while making the limit global. The predicate is the thing under test.
    pool.query.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    await invites.withinRateLimit('ptc-2');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE\s+pt_client_id\s*=\s*\$1/);
    expect(params[0]).toBe('ptc-2');
  });
});
