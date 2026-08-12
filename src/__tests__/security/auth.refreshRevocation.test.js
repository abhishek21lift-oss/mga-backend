// AUD-005 (P1) — a password reset must kill the refresh tokens that existed
// before it.
//
// ── The vulnerability these tests reproduce ─────────────────────────────────
//
// Both password flows already bump `users.token_version`, and middleware/auth.js
// compares that on every request, so ACCESS tokens die immediately. Refresh
// tokens are a different mechanism: rows in `refresh_tokens`, matched by SHA-256
// hash. POST /api/auth/refresh validates one with
//
//     WHERE rt.token_hash = $1 AND rt.expires_at > NOW() AND rt.revoked_at IS NULL
//
// It selects `u.token_version` in that same query — but only to stamp it into
// the new access token. It never compares it to anything. So the refresh table
// has no idea a password ever changed.
//
// The consequence: someone holding a stolen refresh token keeps minting fresh
// 15-minute access tokens for the REFRESH_TOKEN_TTL_MS window — 7 days
// (auth.js:28) — and resetting the password does not stop them. Rotation makes
// it worse, not better: each /refresh issues a replacement, so the attacker's
// access renews itself for as long as they keep using it. 3,989 live refresh
// token rows exist in production.
//
// ── Why the two flows must behave DIFFERENTLY ──────────────────────────────
//
// reset-password  ends with "Please log in with your new password." It issues
//                 no session. Every refresh token must die, including any the
//                 attacker holds.
// change-password deliberately keeps the caller signed in: it sets a fresh
//                 access cookie and calls issueRefreshToken() before returning.
//                 So it must kill every OTHER session but leave the caller's
//                 newly minted one working. Revoking everything after issuing
//                 would log the user out of the browser they just used.
//
// That asymmetry is the contract, read off the existing handlers rather than
// assumed, and cases 3/4/12 below are what stop a future "revoke everything"
// change from silently breaking it.

'use strict';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.DATABASE_URL = 'postgres://test';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');

const USER_A = 'usr-a';
const USER_B = 'usr-b';

const sha = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// ── A refresh_tokens table faithful enough to prove revocation ─────────────
// Statuses are modelled the way the column set actually behaves: a row is
// usable only while revoked_at IS NULL and expires_at is in the future. If this
// were a fixture returning canned rows it could not tell a revoked token from a
// live one, which is the entire property under test.
let mockTokens;   // [{ user_id, token_hash, expires_at, revoked_at }]
let mockUsers;    // { [id]: { id, password, token_version } }
const mockSqlLog = [];

jest.mock('../../db/pool', () => ({
  query: jest.fn(async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    mockSqlLog.push(q);

    // INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
    if (/^INSERT INTO refresh_tokens/i.test(q)) {
      mockTokens.push({ user_id: params[0], token_hash: params[1], expires_at: params[2], revoked_at: null });
      return { rows: [], rowCount: 1 };
    }

    // ORDER MATTERS. The fix writes the password and revokes the refresh rows in
    // ONE data-modifying CTE, so that statement matches the refresh_tokens
    // patterns below as well. It has to be claimed here first, or the mock would
    // revoke the tokens and silently skip the password write — which is exactly
    // what happened on the first run of this harness.
    if (/UPDATE users SET password/i.test(q)) {
      const uid = params[params.length - 1];
      const u = mockUsers[uid];
      if (u) {
        u.password = params[0];
        u.token_version += 1;
        u.reset_hash = null;
      }
      // Combined statement: the same SQL also revokes this user's refresh rows.
      if (/refresh_tokens/i.test(q)) {
        for (const t of mockTokens) {
          if (t.user_id === uid && t.revoked_at === null) t.revoked_at = new Date();
        }
      }
      return { rows: u ? [{ id: uid, token_version: u.token_version }] : [], rowCount: u ? 1 : 0 };
    }

    // Mass revoke for one user, as a standalone statement. Must never touch
    // another user's rows.
    if (/UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE user_id/i.test(q)) {
      const uid = params[params.length - 1];
      let n = 0;
      for (const t of mockTokens) {
        if (t.user_id === uid && t.revoked_at === null) { t.revoked_at = new Date(); n++; }
      }
      return { rows: [], rowCount: n };
    }

    // Single-token revoke (logout, and rotation inside /refresh)
    if (/UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE token_hash/i.test(q)) {
      const t = mockTokens.find((x) => x.token_hash === params[0] && x.revoked_at === null);
      if (t) t.revoked_at = new Date();
      return { rows: [], rowCount: t ? 1 : 0 };
    }

    // The /refresh lookup
    if (/FROM refresh_tokens rt JOIN users u/i.test(q)) {
      const t = mockTokens.find(
        (x) => x.token_hash === params[0] && x.revoked_at === null && new Date(x.expires_at) > new Date()
      );
      if (!t) return { rows: [] };
      const u = mockUsers[t.user_id];
      return { rows: [{ user_id: t.user_id, token_version: u.token_version, is_active: true, deleted_at: null }] };
    }

    // reset-password: find the user by reset-token hash
    if (/SELECT id FROM users WHERE password_reset_token/i.test(q)) {
      const uid = Object.keys(mockUsers).find((id) => mockUsers[id].reset_hash === params[0]);
      return { rows: uid ? [{ id: uid }] : [] };
    }

    // change-password: current password lookup
    if (/SELECT password FROM users WHERE id/i.test(q)) {
      const u = mockUsers[params[0]];
      return { rows: u ? [{ password: u.password }] : [] };
    }

    if (/SELECT token_version FROM users WHERE id/i.test(q)) {
      return { rows: [{ token_version: mockUsers[params[0]].token_version }] };
    }

    return { rows: [] };
  }),
}));

jest.mock('../../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../../lib/email', () => ({ sendPasswordReset: jest.fn(async () => ({ sent: true })) }));
jest.mock('../../lib/loginEvents', () => ({ record: jest.fn() }));
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'JBSWY3DPEHPK3PXP'),
  verifySync: jest.fn(() => ({ valid: false })),
}));

// change-password runs behind `auth`. Only the session is stubbed; the handler
// itself — the code under test — is the real one.
let mockCurrentUser;
jest.mock('../../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  adminOnly: (_r, _s, n) => n(),
  adminOrManager: (_r, _s, n) => n(),
  invalidateUserCache: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

function app() {
  const a = express();
  a.use(express.json());
  a.use(require('cookie-parser')());
  a.use('/api/auth', require('../../routes/auth'));
  return a;
}

/** Put a live refresh token in the table, as issueRefreshToken() would. */
function giveRefreshToken(userId, { expired = false, revoked = false } = {}) {
  const raw = crypto.randomBytes(48).toString('hex');
  mockTokens.push({
    user_id: userId,
    token_hash: sha(raw),
    expires_at: expired ? new Date(Date.now() - 1000) : new Date(Date.now() + 7 * 24 * 3600 * 1000),
    revoked_at: revoked ? new Date() : null,
  });
  return raw;
}

const useRefresh = (raw) => request(app()).post('/api/auth/refresh').send({ refresh_token: raw });

const RESET_RAW = 'reset-token-raw';

beforeEach(async () => {
  mockTokens = [];
  mockSqlLog.length = 0;
  const pw = await bcrypt.hash('OldPassw0rd!', 4);
  mockUsers = {
    [USER_A]: { id: USER_A, password: pw, token_version: 1, reset_hash: sha(RESET_RAW) },
    [USER_B]: { id: USER_B, password: pw, token_version: 1, reset_hash: null },
  };
  mockCurrentUser = { id: USER_A };
});

// ── 1, 6, 9, 10, 11 — reset-password ───────────────────────────────────────
describe('reset-password revokes every refresh token the user had', () => {
  test('1. an existing refresh token is rejected after a successful reset', async () => {
    const stolen = giveRefreshToken(USER_A);

    // Liveness is asserted against the table, NOT by calling /refresh: that
    // endpoint ROTATES, so a pre-flight call would revoke the token itself and
    // the assertion after the reset would pass for the wrong reason. (It did,
    // on the first draft of this test — the pass was rotation, not the fix.)
    expect(mockTokens.find((t) => t.token_hash === sha(stolen)).revoked_at).toBeNull();

    const reset = await request(app()).post('/api/auth/reset-password')
      .send({ token: RESET_RAW, password: 'BrandNewPass1!' });
    expect(reset.status).toBe(200);

    expect((await useRefresh(stolen)).status).toBe(401);
  });

  test('6. ALL of several concurrent sessions are revoked, not just one', async () => {
    const a1 = giveRefreshToken(USER_A);
    const a2 = giveRefreshToken(USER_A);
    const a3 = giveRefreshToken(USER_A);

    await request(app()).post('/api/auth/reset-password')
      .send({ token: RESET_RAW, password: 'BrandNewPass1!' });

    for (const t of [a1, a2, a3]) expect((await useRefresh(t)).status).toBe(401);
  });

  test('5 & 11. another user\'s tokens are untouched', async () => {
    const mine = giveRefreshToken(USER_A);
    const theirs = giveRefreshToken(USER_B);

    await request(app()).post('/api/auth/reset-password')
      .send({ token: RESET_RAW, password: 'BrandNewPass1!' });

    expect((await useRefresh(mine)).status).toBe(401);
    expect((await useRefresh(theirs)).status).toBe(200); // B never reset anything
  });

  test('10. an invalid reset token changes no password and revokes nothing', async () => {
    const live = giveRefreshToken(USER_A);
    const before = mockUsers[USER_A].password;

    const res = await request(app()).post('/api/auth/reset-password')
      .send({ token: 'not-a-real-reset-token', password: 'BrandNewPass1!' });

    expect(res.status).toBe(400);
    expect(mockUsers[USER_A].password).toBe(before);
    expect(mockUsers[USER_A].token_version).toBe(1);
    expect((await useRefresh(live)).status).toBe(200); // still usable
  });

  test('9. a rejected reset (too-short password) leaves the refresh token valid', async () => {
    const live = giveRefreshToken(USER_A);

    const res = await request(app()).post('/api/auth/reset-password')
      .send({ token: RESET_RAW, password: 'short' });

    expect(res.status).toBe(400);
    expect((await useRefresh(live)).status).toBe(200);
  });

  test('revocation happens only AFTER the password write, never before', async () => {
    giveRefreshToken(USER_A);
    await request(app()).post('/api/auth/reset-password')
      .send({ token: RESET_RAW, password: 'BrandNewPass1!' });

    const pwIdx = mockSqlLog.findIndex((s) => /UPDATE users SET password/i.test(s));
    expect(pwIdx).toBeGreaterThanOrEqual(0);

    // No revocation may appear in a statement STRICTLY EARLIER than the password
    // write. Same-statement is the ideal — that is the atomic CTE, and it is
    // what the fix does — so equality is allowed; anything before it is not.
    const earlierRevoke = mockSqlLog
      .slice(0, pwIdx)
      .some((s) => /UPDATE refresh_tokens SET revoked_at/i.test(s));
    expect(earlierRevoke).toBe(false);

    // And the revocation must genuinely be part of that same statement.
    expect(mockSqlLog[pwIdx]).toMatch(/refresh_tokens/i);
  });
});

// ── 2, 3, 4, 12 — change-password keeps the caller signed in ───────────────
describe('change-password revokes other sessions but keeps the caller', () => {
  test('2. a refresh token from another session is rejected afterwards', async () => {
    const otherDevice = giveRefreshToken(USER_A);

    const res = await request(app()).put('/api/auth/change-password')
      .send({ currentPassword: 'OldPassw0rd!', newPassword: 'BrandNewPass1!' });
    expect(res.status).toBe(200);

    expect((await useRefresh(otherDevice)).status).toBe(401);
  });

  test('3 & 4. the caller\'s NEWLY issued refresh token still works', async () => {
    const res = await request(app()).put('/api/auth/change-password')
      .send({ currentPassword: 'OldPassw0rd!', newPassword: 'BrandNewPass1!' });
    expect(res.status).toBe(200);

    // The handler issues a replacement; it must be live, or the user is logged
    // out of the browser they just changed their password in.
    const live = mockTokens.filter((t) => t.user_id === USER_A && t.revoked_at === null);
    expect(live).toHaveLength(1);
  });

  test('5. another user keeps their session through my password change', async () => {
    const theirs = giveRefreshToken(USER_B);
    await request(app()).put('/api/auth/change-password')
      .send({ currentPassword: 'OldPassw0rd!', newPassword: 'BrandNewPass1!' });
    expect((await useRefresh(theirs)).status).toBe(200);
  });

  test('a wrong current password revokes nothing', async () => {
    const live = giveRefreshToken(USER_A);
    const res = await request(app()).put('/api/auth/change-password')
      .send({ currentPassword: 'WrongPassword!', newPassword: 'BrandNewPass1!' });

    expect(res.status).toBe(401);
    expect((await useRefresh(live)).status).toBe(200);
  });
});

// ── 7, 8, 12 — behaviour that must not regress ─────────────────────────────
describe('existing refresh semantics are preserved', () => {
  test('7. an already-revoked token stays rejected', async () => {
    const dead = giveRefreshToken(USER_A, { revoked: true });
    expect((await useRefresh(dead)).status).toBe(401);
  });

  test('8. an expired token stays rejected', async () => {
    const old = giveRefreshToken(USER_A, { expired: true });
    expect((await useRefresh(old)).status).toBe(401);
  });

  test('12. rotation still works: using a token revokes it and issues a replacement', async () => {
    const first = giveRefreshToken(USER_A);
    const res = await useRefresh(first);

    expect(res.status).toBe(200);
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.refresh_token).not.toBe(first);

    // The one just used is dead; the replacement is live.
    expect((await useRefresh(first)).status).toBe(401);
    expect((await useRefresh(res.body.refresh_token)).status).toBe(200);
  });

  test('no raw token or hash is ever written to the logs', async () => {
    const logger = require('../../lib/logger');
    const raw = giveRefreshToken(USER_A);
    await request(app()).post('/api/auth/reset-password')
      .send({ token: RESET_RAW, password: 'BrandNewPass1!' });

    const everything = JSON.stringify([
      ...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls,
    ]);
    expect(everything).not.toContain(raw);
    expect(everything).not.toContain(sha(raw));
    expect(everything).not.toContain(RESET_RAW);
  });
});

// ── Every password-write path in the backend, not just the two obvious ones ──
//
// The first version of this fix covered auth.js and left two holes open:
// profile.js PUT /password (a second, parallel change-password route) and the
// super-admin POST /users/:id/reset-password — whose comment and response BOTH
// claimed "existing sessions revoked" while revoking nothing but access tokens.
// An attacker only needs one uncovered path, so this asserts the invariant
// across the whole repository rather than at the two sites we happened to fix.
describe('no password-write path bypasses refresh-token revocation', () => {
  const fs = require('fs');
  const path = require('path');

  const SRC = path.join(__dirname, '..', '..');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(p);
    return p.endsWith('.js') ? [p] : [];
  });

  // Statements that set an EXISTING account's password. Excluded by design:
  //   · db/seed.js            — fixture bootstrap, not a running account
  //   · client-activation.js  — sets the FIRST password on an account that had
  //   · invitations.js          none, so there is no prior session to revoke
  const FIRST_PASSWORD_PATHS = ['seed.js', 'client-activation.js', 'invitations.js'];

  test('every statement that changes an existing password also revokes refresh tokens', () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      if (FIRST_PASSWORD_PATHS.some((f) => file.endsWith(f))) continue;
      const src = fs.readFileSync(file, 'utf8');
      // A password write is recognised by the token_version bump that always
      // accompanies it — that is the repo's existing marker for "this changes
      // an account's credentials".
      const re = /UPDATE users\s+SET password[\s\S]{0,400}?token_version = token_version \+ 1/gi;
      let m;
      while ((m = re.exec(src)) !== null) {
        // Widen to the whole statement: back to the opening backtick/quote and
        // forward to the closing one.
        const start = src.lastIndexOf('`', m.index);
        const end = src.indexOf('`', m.index + m[0].length);
        const stmt = start !== -1 && end !== -1 ? src.slice(start, end) : m[0];
        if (!/refresh_tokens/i.test(stmt)) {
          offenders.push(`${path.relative(SRC, file)} :: ${m[0].slice(0, 60).replace(/\s+/g, ' ')}…`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the audit actually finds the password writes (guards against passing on nothing)', () => {
    let found = 0;
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      const m = src.match(/UPDATE users\s+SET password[\s\S]{0,400}?token_version = token_version \+ 1/gi);
      if (m) found += m.length;
    }
    // auth.js reset + auth.js change + profile.js + super-admin reset
    expect(found).toBeGreaterThanOrEqual(4);
  });
});
