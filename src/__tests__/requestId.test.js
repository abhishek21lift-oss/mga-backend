const request = require('supertest');
const express = require('express');
const requestId = require('../middleware/requestId');

const app = express();
app.use(requestId);
app.get('/probe', (req, res) => {
  res.json({ id: req.id });
});

describe('requestId middleware', () => {
  it('generates a request id and sets x-request-id header', async () => {
    const res = await request(app).get('/probe');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(/[0-9a-f-]{8,}/i);
    expect(res.body.id).toBe(res.headers['x-request-id']);
  });

  it('echoes the incoming x-request-id header when present', async () => {
    const incoming = '11111111-2222-3333-4444-555555555555';
    const res = await request(app).get('/probe').set('x-request-id', incoming);
    expect(res.headers['x-request-id']).toBe(incoming);
    expect(res.body.id).toBe(incoming);
  });
});
