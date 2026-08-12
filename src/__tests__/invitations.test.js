// Admin invitations.
//
// This is a PUBLIC, UNAUTHENTICATED write surface that hands out admin access
// to a studio. The token is the only credential. So these tests are weighted
// toward what must never happen rather than toward the happy path:
//
//   • a raw token must never be stored
//   • a used token must never work twice
//   • an expired token must never work
//   • rejections must be indistinguishable from each other
//   • the password rule the server enforces must not be weaker than the one
//     the UI shows, because curl skips the UI entirely

process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.example.com';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
const pool = require('../db/pool');
const invitations = require('../lib/invitations');
const { validatePassword } = require('../routes/invitations');
const { invitationHtml, invitationText } = require('../lib/emailTemplates/invitation');
const { apiBaseUrl } = require('../lib/apiUrl');

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
});

/** A row as the database would hand it back. */
const row = (over = {}) => ({
  id: 'inv-1', user_id: 'usr-1', organization_id: 'org-1',
  email: 'owner@example.com', owner_name: 'Vivek', studio_name: 'Vivek Fitness',
  status: 'sent',
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  sent_at: null, opened_at: null, activated_at: null, cancelled_at: null,
  send_attempts: 1, last_error: null,
  created_by_name: 'Operator', created_at: new Date().toISOString(),
  token_hash: 'SHOULD-NEVER-LEAK',
  ...over,
});

describe('tokens', () => {
  it('issues a long random token and stores only its hash', () => {
    const { raw, hash } = invitations.issueToken();
    expect(raw).toHaveLength(64);              // 32 bytes hex
    expect(hash).toHaveLength(64);             // sha256 hex
    expect(hash).not.toBe(raw);
    expect(invitations.hashToken(raw)).toBe(hash);
  });

  it('never issues the same token twice', () => {
    const seen = new Set(Array.from({ length: 200 }, () => invitations.issueToken().raw));
    expect(seen.size).toBe(200);
  });
});

describe('present() — the API projection', () => {
  it('never exposes the token hash', () => {
    // The hash is not the secret, but it is the value an attacker would need
    // to confirm a guessed token offline. It has no business leaving the box.
    const out = invitations.present(row());
    expect(JSON.stringify(out)).not.toContain('SHOULD-NEVER-LEAK');
    expect(out.token_hash).toBeUndefined();
  });
});

describe('effectiveStatus — expiry is derived, not stored', () => {
  it('reports a lapsed invitation as expired even though the column says sent', () => {
    // Nothing sweeps this table. Without deriving it, the management list
    // would show yesterday's dead invitations as still live.
    expect(invitations.effectiveStatus(row({
      status: 'sent', expires_at: new Date(Date.now() - 1000).toISOString(),
    }))).toBe('expired');
  });

  it('leaves an activated invitation activated after its expiry passes', () => {
    // Rewriting a completed onboarding to 'expired' would claim the studio
    // never activated, which is the opposite of what happened.
    expect(invitations.effectiveStatus(row({
      status: 'activated', expires_at: new Date(Date.now() - 86_400_000).toISOString(),
    }))).toBe('activated');
  });

  it('leaves a cancelled invitation cancelled', () => {
    expect(invitations.effectiveStatus(row({
      status: 'cancelled', expires_at: new Date(Date.now() - 1000).toISOString(),
    }))).toBe('cancelled');
  });

  it('reports a live invitation as-is', () => {
    expect(invitations.effectiveStatus(row({ status: 'opened' }))).toBe('opened');
  });
});

describe('resolve — what a token is worth', () => {
  const asRow = (over) => ({ ...row(over), org_name: 'Vivek Fitness', user_email: 'owner@example.com' });

  it('looks the token up by HASH, never by its raw value', async () => {
    const raw = 'a'.repeat(64);
    pool.query.mockResolvedValue({ rows: [asRow()] });
    await invitations.resolve(raw);
    const [, params] = pool.query.mock.calls[0];
    expect(params[0]).toBe(invitations.hashToken(raw));
    expect(params[0]).not.toBe(raw);
  });

  it('rejects a token that has already been used', async () => {
    // The single-use property. Without it a forwarded email lets a second
    // person re-set the password on a live studio.
    pool.query.mockResolvedValue({ rows: [asRow({ status: 'activated' })] });
    const res = await invitations.resolve('a'.repeat(64));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('used');
  });

  it('rejects an expired token', async () => {
    pool.query.mockResolvedValue({
      rows: [asRow({ status: 'sent', expires_at: new Date(Date.now() - 1000).toISOString() })],
    });
    const res = await invitations.resolve('a'.repeat(64));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('expired');
  });

  it('rejects a cancelled token', async () => {
    pool.query.mockResolvedValue({ rows: [asRow({ status: 'cancelled' })] });
    expect((await invitations.resolve('a'.repeat(64))).reason).toBe('cancelled');
  });

  it('accepts a live token', async () => {
    pool.query.mockResolvedValue({ rows: [asRow()] });
    expect((await invitations.resolve('a'.repeat(64))).ok).toBe(true);
  });

  it.each([undefined, null, '', 'short', 123, {}])(
    'refuses %p without touching the database', async (bad) => {
      // A malformed token must not become a query. Short-circuiting also keeps
      // the response time flat, so timing does not leak whether a lookup ran.
      const res = await invitations.resolve(bad);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('invalid');
      expect(pool.query).not.toHaveBeenCalled();
    }
  );

  it('reports an unknown token as invalid, the same as a malformed one', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    expect((await invitations.resolve('a'.repeat(64))).reason).toBe('invalid');
  });
});

describe('rate limiting', () => {
  it('counts rows in the window rather than trusting a process counter', async () => {
    // The API runs on more than one instance; an in-memory counter would
    // multiply the real limit by the number of instances and reset on deploy.
    pool.query.mockResolvedValue({ rows: [{ n: 1 }] });
    const r = await invitations.withinRateLimit('usr-1');
    expect(r.ok).toBe(true);
    expect(pool.query.mock.calls[0][0]).toMatch(/FROM admin_invitations/);
    expect(pool.query.mock.calls[0][0]).toMatch(/created_at >= now\(\)/);
  });

  it('blocks once the limit is reached', async () => {
    pool.query.mockResolvedValue({ rows: [{ n: invitations.RATE_LIMIT_MAX }] });
    const r = await invitations.withinRateLimit('usr-1');
    expect(r.ok).toBe(false);
    expect(r.used).toBe(invitations.RATE_LIMIT_MAX);
  });

  it('allows the last send below the limit', async () => {
    pool.query.mockResolvedValue({ rows: [{ n: invitations.RATE_LIMIT_MAX - 1 }] });
    expect((await invitations.withinRateLimit('usr-1')).ok).toBe(true);
  });

  it('defaults to three per hour', () => {
    expect(invitations.RATE_LIMIT_MAX).toBe(3);
    expect(invitations.RATE_LIMIT_WINDOW_HOURS).toBe(1);
  });
});

describe('create', () => {
  it('stores the hash and returns the raw token to the caller only once', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [row()] }) };
    const out = await invitations.create({
      client, userId: 'usr-1', organizationId: 'org-1',
      email: 'Owner@Example.com', ownerName: 'Vivek', studioName: 'VF',
      req: { user: { id: 'op', name: 'Operator' }, ip: '1.2.3.4', get: () => 'UA' },
    });
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO admin_invitations/);
    expect(params).toContain(invitations.hashToken(out.token));
    expect(params).not.toContain(out.token);
    // Lower-cased, so a resend to "Owner@" matches the row written for "owner@".
    expect(params[2]).toBe('owner@example.com');
  });

  it('records who issued it, from where', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [row()] }) };
    await invitations.create({
      client, userId: 'u', organizationId: 'o', email: 'a@b.c',
      req: { user: { id: 'op-1', name: 'Operator' }, ip: '9.9.9.9', get: () => 'Chrome' },
    });
    const params = client.query.mock.calls[0][1];
    expect(params).toEqual(expect.arrayContaining(['op-1', 'Operator', '9.9.9.9', 'Chrome']));
  });

  it('expires in 24 hours by default', () => {
    expect(invitations.EXPIRY_HOURS).toBe(24);
  });
});

describe('supersedeOpen', () => {
  it('cancels every open invitation for the account', async () => {
    // A resend exists because the previous link may have gone astray. Leaving
    // it live would defeat the reason for resending.
    await invitations.supersedeOpen('usr-1');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'cancelled'/);
    expect(params[1]).toEqual(invitations.OPEN_STATUSES);
    expect(params[1]).not.toContain('activated');
  });
});

describe('markOpened — tracking cannot rewrite history', () => {
  it('only advances an invitation that is still pending or sent', async () => {
    // Mail clients re-fetch images long after the fact, including after the
    // studio has activated. That must not walk the status backwards.
    await invitations.markOpened('track-1');
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status IN \('pending','sent'\)/);
    expect(sql).toMatch(/track_id = \$1/);
    // Keyed on track_id, never the token — a pixel URL travels through image
    // proxies and referrer headers.
    expect(sql).not.toMatch(/token_hash/);
  });
});

describe('password rules — the server is where they actually live', () => {
  it.each([
    ['short', 'Aa1!x'],
    ['no lowercase', 'PASSWORD1!'],
    ['no uppercase', 'password1!'],
    ['no number', 'Password!'],
    ['no special character', 'Password1'],
  ])('rejects a password with %s', (_label, pw) => {
    expect(validatePassword(pw)).toBeTruthy();
  });

  it('accepts one that meets every rule', () => {
    expect(validatePassword('Str0ng!Pass')).toBeNull();
  });

  it('refuses an absurdly long password', () => {
    // bcrypt truncates past 72 bytes anyway; an unbounded input is just a
    // hashing cost an unauthenticated caller gets to choose.
    expect(validatePassword(`Aa1!${'x'.repeat(500)}`)).toBeTruthy();
  });
});

describe('the email itself', () => {
  const vars = {
    ownerName: 'Vivek Verma', studioName: 'Vivek Fitness',
    email: 'owner@example.com', actionUrl: 'https://app.example.com/auth/set-password?token=abc',
    pixelUrl: 'https://api.example.com/api/invitations/track/t.gif', expiryHours: 24,
  };

  it('never contains a password', () => {
    // The rule the whole feature exists for.
    const html = invitationHtml(vars).toLowerCase();
    expect(html).not.toMatch(/your password is/);
    expect(html).not.toMatch(/temporary password/);
  });

  it('carries a plain-text alternative', () => {
    // A message with no text/plain part scores worse with spam filters, and
    // this is the one email that must not land in junk.
    const text = invitationText(vars);
    expect(text).toContain(vars.actionUrl);
    expect(text).toContain('MY PT STUDIO');
    expect(text).not.toContain('<');
  });

  it('escapes names so a studio name cannot inject markup', () => {
    const html = invitationHtml({ ...vars, ownerName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders without a pixel when the API has no public URL', () => {
    // Better no tracking than a relative image that resolves against the mail
    // client and shows as broken.
    const html = invitationHtml({ ...vars, pixelUrl: undefined });
    expect(html).not.toContain('<img');
  });

  it('states the expiry the code actually enforces', () => {
    expect(invitationHtml(vars)).toContain('24 hours');
  });

  it('offers a copyable link for clients that mangle the button', () => {
    expect(invitationHtml(vars).match(/https:\/\/app\.example\.com\/auth\/set-password/g).length)
      .toBeGreaterThan(1);
  });
});

describe('apiBaseUrl — where a machine fetches', () => {
  it('prefers an explicit override', () => {
    expect(apiBaseUrl({ PUBLIC_API_URL: 'https://api.example.com/', RENDER_EXTERNAL_URL: 'https://x.onrender.com' }))
      .toBe('https://api.example.com');
  });

  it('falls back to the Render-injected URL', () => {
    expect(apiBaseUrl({ RENDER_EXTERNAL_URL: 'https://x.onrender.com' })).toBe('https://x.onrender.com');
  });

  it('returns null for localhost rather than emitting an unreachable pixel', () => {
    // A recipient's mail client cannot reach our localhost; the image would
    // break on every open for no benefit.
    expect(apiBaseUrl({ PUBLIC_API_URL: 'http://localhost:5000' })).toBeNull();
  });

  it('returns null when nothing is configured', () => {
    expect(apiBaseUrl({})).toBeNull();
  });
});
