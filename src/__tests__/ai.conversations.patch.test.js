jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'usr-1', role: 'admin', organization_id: 'org-1' }; next(); },
  adminOnly: (_req, _res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

process.env.OPENROUTER_API_KEY = 'test-key';
const aiRouter = require('../routes/ai');

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);

describe('PATCH /api/ai/conversations/:id', () => {
  beforeEach(() => pool.query.mockReset());

  it('renames a conversation', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'c1', title: 'Renewals plan', pinned: false }] });
    const res = await request(app).patch('/api/ai/conversations/c1').send({ title: '  Renewals plan  ' });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Renewals plan');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SET title = \$3/);
    // Scoped to the caller — another user's conversation can't be renamed.
    expect(params[1]).toBe('usr-1');
    // Renaming is not activity: updated_at must not be bumped, or the
    // history list would reorder itself under the user.
    expect(sql).not.toMatch(/updated_at\s*=/);
  });

  it('pins a conversation', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'c1', title: 'x', pinned: true }] });
    const res = await request(app).patch('/api/ai/conversations/c1').send({ pinned: true });
    expect(res.status).toBe(200);
    expect(res.body.data.pinned).toBe(true);
    expect(pool.query.mock.calls[0][0]).toMatch(/SET pinned = \$3/);
  });

  it('updates both fields at once', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'c1', title: 'y', pinned: true }] });
    const res = await request(app).patch('/api/ai/conversations/c1').send({ title: 'y', pinned: true });
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][0]).toMatch(/title = \$3, pinned = \$4/);
  });

  it('rejects an empty title rather than blanking it', async () => {
    const res = await request(app).patch('/api/ai/conversations/c1').send({ title: '   ' });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a request with nothing to update', async () => {
    const res = await request(app).patch('/api/ai/conversations/c1').send({});
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('404s when the conversation belongs to someone else', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).patch('/api/ai/conversations/nope').send({ pinned: true });
    expect(res.status).toBe(404);
  });
});
