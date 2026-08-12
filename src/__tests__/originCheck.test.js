const request = require('supertest');
const express = require('express');
const { originCheck } = require('../middleware/originCheck');

function app() {
  const a = express();
  // Mounted exactly as server.js does — the mount path matters, because
  // Express strips it and req.path inside the middleware is the remainder.
  a.use('/api/', originCheck);
  a.get('/api/health', (_q, s) => s.json({ ok: true }));
  a.get('/api/calendar/callback', (_q, s) => s.json({ ok: true }));
  a.get('/api/clients', (_q, s) => s.json({ ok: true }));
  return a;
}

const OLD = process.env.FRONTEND_URL;
beforeAll(() => { process.env.FRONTEND_URL = 'https://www.619fitnessstudio.com/'; });
afterAll(() => { process.env.FRONTEND_URL = OLD; });

describe('originCheck', () => {
  it('lets the Google OAuth callback through despite a third-party referer', async () => {
    // The regression this exists for: Google redirects the browser back with
    // Referer: accounts.google.com, an allowlist can only reject it, and
    // connecting a calendar failed with {"error":"Forbidden"}.
    const res = await request(app())
      .get('/api/calendar/callback?code=abc&state=xyz')
      .set('Referer', 'https://accounts.google.com/');
    expect(res.status).toBe(200);
  });

  it('exempts the health check even when a referer is present', async () => {
    // The old exemption compared req.path to '/api/health', which never
    // matched because the mount path is stripped. It only looked fine because
    // Render's probe sends no headers at all.
    const res = await request(app())
      .get('/api/health')
      .set('Referer', 'https://somewhere-else.example/');
    expect(res.status).toBe(200);
  });

  it('still blocks an unknown origin on a normal API route', async () => {
    const res = await request(app())
      .get('/api/clients')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('allows the configured frontend, trailing slash and all', async () => {
    const res = await request(app())
      .get('/api/clients')
      .set('Origin', 'https://www.619fitnessstudio.com');
    expect(res.status).toBe(200);
  });

  it('passes server-to-server calls that send neither header', async () => {
    const res = await request(app()).get('/api/clients');
    expect(res.status).toBe(200);
  });
});
