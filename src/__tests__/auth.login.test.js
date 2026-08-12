jest.mock('../db/pool', () => {
  const store = [
    {
      id: 'usr-1',
      name: 'Admin',
      email: 'admin@619fitness.com',
      password: '$2a$10$abcdefghijklmnopqrstuv', // not a real hash; bcrypt.compare mocked below
      role: 'admin',
      trainer_id: null,
      member_id: null,
      is_active: true,
      token_version: 0,
      organization_id: 'org-1',
      organization_name: 'Test Studio',
      organization_logo_url: null,
    },
  ];
  return {
    query: jest.fn(async function(sql, params) {
      // Matched on the shape that survives edits — a SELECT against `users`
      // filtering on a lower-cased email. The previous pattern pinned the
      // exact old text (`SELECT * FROM users WHERE LOWER(email)`), so when the
      // real query gained its LEFT JOIN on organizations the mock silently
      // stopped matching, returned no rows, and login 401'd. Nobody saw it
      // because the suite could not even parse.
      // Matches either spelling of the same intent: the direct SELECT this
      // used to be, or auth_user_by_email(), the SECURITY DEFINER function it
      // became so that login can find a tenant user under RLS (migration 160).
      // Pinned to intent rather than to SQL text, for the reason above.
      if ((/from\s+users/i.test(sql) && /lower\(\s*u?\.?email\s*\)/i.test(sql))
          || /auth_user_by_email/i.test(sql)) {
        const email = (params && params[0]) || '';
        const row = store.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
        return { rows: row ? [row] : [] };
      }
      if (/UPDATE users SET last_login/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
});

jest.mock('bcryptjs', () => ({
  compare: jest.fn(async function(plain, hash) {
    return plain === 'correct-password' && hash && hash.length > 0;
  }),
}));

const request = require('supertest');
const express = require('express');
// routes/auth.js requires otplib, whose CJS build in turn requires the
// ESM-only @scure/base. Node can resolve that; Jest's own module resolver
// cannot, and the suite failed to parse before it ran a single assertion.
// This test covers password login, not TOTP, so otplib is stubbed out — the
// real module is exercised by otplib.contract.test.js under plain Node.
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'JBSWY3DPEHPK3PXP'),
  verifySync: jest.fn(() => ({ valid: false })),
}));

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.DATABASE_URL = 'postgres://test';
process.env.FRONTEND_URL = 'https://test.example.com';
process.env.NODE_ENV = 'test';

const authRouter = require('../routes/auth');
const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

describe('POST /api/auth/login', () => {
  it('returns 200 and sets a token cookie for valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@619fitness.com', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('admin@619fitness.com');
    expect(res.headers['set-cookie']).toBeDefined();
    expect(res.headers['set-cookie'].join(';')).toMatch(/token=/);
  });

  it('returns 401 for invalid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@619fitness.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@619fitness.com', password: 'correct-password' });
    expect(res.status).toBe(401);
  });
});
