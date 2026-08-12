// Mocked against otplib v13's functional API. This mock previously described
// v12's `authenticator` singleton, which is why it kept passing after the
// dependency was bumped and the real code had already broken — the mock was
// asserting an API that no longer existed. otplib.contract.test.js now pins
// the real shape so that cannot recur.
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'JBSWY3DPEHPK3PXP'),
  verifySync: jest.fn(),
}));

jest.mock('../db/pool', () => ({
  query: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'a'.repeat(64);

const profileRouter = require('../routes/profile');
const pool = require('../db/pool');
const { verifySync } = require('otplib');

const app = express();
app.use(express.json());
app.use('/api/profile', profileRouter);

const trainerToken = jwt.sign(
  { id: 'usr-1', token_version: 0 },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);

function withAuth(req) {
  return req.set('Authorization', 'Bearer ' + trainerToken);
}

const adminUser = {
  id: 'usr-1', name: 'Admin', email: 'admin@619fitness.com', role: 'admin',
  trainer_id: null, member_id: null, branch_id: null, is_active: true, token_version: 0,
};

describe('POST /api/profile/mfa/verify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockProfilePool({ mfaSecret }) {
    pool.query.mockImplementation(async function() {
      // The auth middleware's per-request user read became
      // auth_user_by_id() in migration 160, so it can find a tenant user
      // before tenant context exists. Match either spelling.
      if (/FROM\s+users/i.test(arguments[0]) || /auth_user_by_id/i.test(arguments[0])) {
        return { rows: [adminUser] };
      }
      if (/INSERT INTO user_profiles/i.test(arguments[0])) {
        return { rows: [] };
      }
      if (/SELECT mfa_secret FROM user_profiles/i.test(arguments[0])) {
        return { rows: [{ mfa_secret: mfaSecret }] };
      }
      if (/UPDATE user_profiles/i.test(arguments[0])) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  }

  it('returns 400 if no secret is stored on the user', async () => {
    mockProfilePool({ mfaSecret: null });
    const res = await withAuth(request(app).post('/api/profile/mfa/verify').send({ code: '123456' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/setup required/i);
  });

  it('returns 400 for an incorrect TOTP code', async () => {
    mockProfilePool({ mfaSecret: 'JBSWY3DPEHPK3PXP' });
    verifySync.mockReturnValue({ valid: false });
    const res = await withAuth(request(app).post('/api/profile/mfa/verify').send({ code: '000000' }));
    expect(res.status).toBe(400);
    expect(verifySync).toHaveBeenCalledWith({
      secret: 'JBSWY3DPEHPK3PXP', token: '000000', strategy: 'totp', epochTolerance: 30,
    });
  });

  it('returns 200 with recovery codes for a correct TOTP code', async () => {
    mockProfilePool({ mfaSecret: 'JBSWY3DPEHPK3PXP' });
    verifySync.mockReturnValue({ valid: true });
    const res = await withAuth(request(app).post('/api/profile/mfa/verify').send({ code: '123456' }));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recoveryCodes)).toBe(true);
    expect(res.body.recoveryCodes).toHaveLength(8);
  });
});
