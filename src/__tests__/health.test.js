jest.mock('../db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../lib/redis', () => ({
  ping: jest.fn(),
}));

const pool = require('../db/pool');
const redis = require('../lib/redis');
const { getHealthPayload, sendHealthResponse } = require('../lib/health');

describe('Health Check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ok with connected db and redis when both are healthy', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    redis.ping.mockResolvedValueOnce('PONG');

    const payload = await getHealthPayload();

    expect(payload.status).toBe('ok');
    expect(payload.version).toBe('v3');
    expect(payload.db).toBe('connected');
    expect(payload.redis).toBe('connected');
    expect(payload.time).toBeDefined();
  });

  it('reports redis as disconnected when the ping fails', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    redis.ping.mockRejectedValueOnce(new Error('redis down'));

    const payload = await getHealthPayload();

    expect(payload.redis).toBe('disconnected');
  });

  it('returns a 503 response with the existing error fields plus redis status', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    redis.ping.mockRejectedValueOnce(new Error('redis down'));

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await sendHealthResponse({}, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      db: 'disconnected',
      redis: 'disconnected',
      error: 'db down',
    }));
  });
});
