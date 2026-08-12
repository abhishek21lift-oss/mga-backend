// Operator overrides for AI model routing.
//
// The property under test is not "an override works" — it is that NOTHING
// about this can change which model a live request routes to unless an
// operator deliberately set one. models.js is on the hot path of every AI
// call; a regression here is a platform-wide outage with no error message,
// because a bad model id just makes the provider return 400 forever.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
const pool = require('../db/pool');
const settings = require('../lib/ai/settings');
const { models, DEFAULTS } = require('../lib/ai/models');

const ENV_KEYS = ['AI_PRIMARY_MODEL', 'AI_SECONDARY_MODEL', 'AI_FALLBACK_MODEL'];
const saved = {};

beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  settings.stop();
});

beforeEach(() => {
  pool.query.mockReset();
  settings._setCache(null);
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('resolution order', () => {
  it('falls back to the built-in default with no override and no env', () => {
    expect(models.primary).toBe(DEFAULTS.primary);
    expect(models.secondary).toBe(DEFAULTS.secondary);
    expect(models.fallback).toBe(DEFAULTS.fallback);
  });

  it('prefers the environment variable over the built-in default', () => {
    process.env.AI_PRIMARY_MODEL = 'vendor/from-env';
    expect(models.primary).toBe('vendor/from-env');
  });

  it('prefers an operator override over the environment variable', () => {
    process.env.AI_PRIMARY_MODEL = 'vendor/from-env';
    settings._setCache({ primary_model: 'vendor/from-operator' });
    expect(models.primary).toBe('vendor/from-operator');
  });

  it('overrides each tier independently', () => {
    process.env.AI_SECONDARY_MODEL = 'vendor/env-secondary';
    settings._setCache({ primary_model: 'vendor/only-primary' });
    expect(models.primary).toBe('vendor/only-primary');
    // Untouched tiers must keep resolving exactly as before.
    expect(models.secondary).toBe('vendor/env-secondary');
    expect(models.fallback).toBe(DEFAULTS.fallback);
  });

  it.each([null, '', '   '])('treats %p as no override at all', (v) => {
    process.env.AI_PRIMARY_MODEL = 'vendor/from-env';
    settings._setCache({ primary_model: v });
    expect(models.primary).toBe('vendor/from-env');
  });
});

describe('failure modes never change routing', () => {
  it('an empty cache resolves exactly as before this feature existed', () => {
    // This is the state at boot, before the first refresh returns.
    process.env.AI_PRIMARY_MODEL = 'vendor/from-env';
    settings._setCache(null);
    expect(models.primary).toBe('vendor/from-env');
  });

  it('a failed refresh does not clear an override already in force', async () => {
    // A transient database blip must not silently swap live traffic back to
    // the environment default mid-flight.
    settings._setCache({ primary_model: 'vendor/from-operator' });
    pool.query.mockRejectedValue(new Error('connection lost'));
    await settings.refresh();
    expect(models.primary).toBe('vendor/from-operator');
  });

  it('a failed refresh never throws', async () => {
    pool.query.mockRejectedValue(new Error('boom'));
    await expect(settings.refresh()).resolves.toBeDefined();
  });

  it('a missing settings row leaves everything on the environment', async () => {
    process.env.AI_PRIMARY_MODEL = 'vendor/from-env';
    pool.query.mockResolvedValue({ rows: [] });
    await settings.refresh();
    expect(models.primary).toBe('vendor/from-env');
  });
});

describe('refresh', () => {
  it('loads the singleton row into the cache', async () => {
    pool.query.mockResolvedValue({
      rows: [{ primary_model: 'vendor/a', secondary_model: null, fallback_model: 'vendor/c' }],
    });
    await settings.refresh();
    expect(models.primary).toBe('vendor/a');
    // A null column means that tier keeps following the environment.
    expect(models.secondary).toBe(DEFAULTS.secondary);
    expect(models.fallback).toBe('vendor/c');
  });
});

describe('the poller cannot hold the process open', () => {
  it('unrefs its timer', () => {
    pool.query.mockResolvedValue({ rows: [] });
    settings.start();
    // A referenced interval here would stop jest exiting and stall a
    // container shutdown — both silent, both painful to trace back.
    const t = settings._timer();
    expect(t).toBeTruthy();
    expect(t.hasRef()).toBe(false);
    settings.stop();
  });
});
