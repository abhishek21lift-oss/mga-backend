'use strict';

/**
 * The deployment topology, as a contract rather than a comment.
 *
 * BullMQ arrived with everything it needs in the application. What it did not
 * have was a Redis service on the box it runs on: the only file describing a
 * topology described a hosting platform this app does not run on, and nothing
 * described the VPS. Without a `redis`
 * service, REDIS_URL stays unset there and every queue silently degrades to
 * the pre-queue inline path — safe, and completely inert.
 *
 * These tests guard the handful of details in docker-compose.yml that would
 * break the topology quietly rather than loudly. Each of them produces a
 * running stack that looks fine:
 *
 *   - a worker `command` pointing at a file that no longer exists means the
 *     container restart-loops while the API keeps enqueueing into a queue
 *     nobody drains;
 *   - RUN_WORKERS unset on the api service means BOTH processes drain every
 *     queue, doubling the load on a box that has one core to spare;
 *   - an LRU eviction policy on Redis deletes job hashes under memory
 *     pressure, which is data loss dressed up as a cache miss;
 *   - the image's HEALTHCHECK wgets /api/health, and the worker container runs
 *     no HTTP server, so it reports unhealthy forever and `docker compose ps`
 *     stops being able to show a real problem.
 *
 * This file cannot verify the compose file on the VPS, which is the one that
 * actually runs and lives outside this repository. It verifies the one we can
 * review.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const COMPOSE = path.join(ROOT, 'docker-compose.yml');

/** Minimal reader — the file is ours and its shape is asserted below. */
function readCompose() {
  const raw = fs.readFileSync(COMPOSE, 'utf8');
  return { raw, lines: raw.split('\n') };
}

/** Comment lines removed — prose explaining why NOT to do a thing must not
 *  trip an assertion that the thing is absent. */
function stripComments(block) {
  return block.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

/** The block of `raw` belonging to one service, up to the next service. */
function serviceBlock(raw, name) {
  const start = raw.indexOf(`\n  ${name}:`);
  if (start === -1) throw new Error(`No service "${name}" in docker-compose.yml`);
  const rest = raw.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('docker-compose.yml', () => {
  const { raw } = readCompose();

  it('exists, because nothing else describes the VPS topology', () => {
    expect(fs.existsSync(COMPOSE)).toBe(true);
  });

  it('declares redis, api and worker', () => {
    for (const svc of ['redis', 'api', 'worker']) {
      expect(raw).toContain(`\n  ${svc}:`);
    }
  });
});

describe('the worker service', () => {
  const { raw } = readCompose();
  const worker = serviceBlock(raw, 'worker');

  it('runs an entrypoint that exists on disk', () => {
    // The failure this catches is silent: a renamed worker file leaves the
    // container restart-looping while the API happily enqueues into a queue
    // nobody is draining.
    const m = worker.match(/command:\s*\[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const file = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).pop();
    expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
  });

  it('runs an entrypoint that starts workers when executed directly', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/workers/index.js'), 'utf8');
    expect(src).toContain('require.main === module');
    expect(src).toMatch(/startWorkers\(\)/);
  });

  it('disables the image healthcheck', () => {
    // The Dockerfile's HEALTHCHECK wgets /api/health. This container runs no
    // HTTP server, so it would sit permanently unhealthy.
    expect(worker).toMatch(/healthcheck:\s*\n\s*disable:\s*true/);
  });

  it('is given longer than the default to drain', () => {
    // Workers finish in-flight jobs on SIGTERM. Being SIGKILLed mid-drain is
    // exactly what the drain exists to prevent — on the renewal queue that is
    // a card charged with no membership row written.
    const m = worker.match(/stop_grace_period:\s*(\d+)s/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThan(10);
  });

  it('carries the credentials only it needs', () => {
    // The worker sends WhatsApp and charges renewals; the API does neither.
    for (const key of ['TWILIO_ACCOUNT_SID', 'RAZORPAY_KEY_SECRET']) {
      expect(worker).toContain(key);
    }
  });
});

describe('the api service', () => {
  const { raw } = readCompose();
  const api = serviceBlock(raw, 'api');

  it('does not also drain the queues', () => {
    // Both draining is not incorrect — BullMQ handles it — but it doubles the
    // load on a box with one core to spare, for no extra throughput.
    expect(api).toMatch(/RUN_WORKERS:\s*['"]0['"]/);
  });

  it('points at the redis service by name', () => {
    // `redis` is also lib/redis.js's DEFAULT_HOST, so the two agree by
    // construction rather than by coincidence.
    expect(api).toMatch(/redis:\/\/redis:6379/);
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/redis.js'), 'utf8');
    expect(src).toMatch(/DEFAULT_HOST\s*=\s*'redis'/);
  });
});

describe('the redis service', () => {
  const { raw } = readCompose();
  const redis = serviceBlock(raw, 'redis');

  it('persists, so a restart does not empty the queue', () => {
    expect(redis).toContain('--appendonly');
  });

  it('never evicts, because eviction here is job loss', () => {
    // allkeys-lru would delete job hashes under memory pressure — data loss
    // dressed up as a cache miss. BullMQ would rather the write fail.
    expect(redis).toContain('noeviction');
    expect(stripComments(redis)).not.toMatch(/allkeys-lru|volatile-/);
  });

  it('is bound to loopback', () => {
    // An internet-reachable Redis with no password is how a box ends up
    // mining somebody else's cryptocurrency.
    expect(redis).toMatch(/'127\.0\.0\.1:6379:6379'/);
  });

  it('gates the dependants on a real healthcheck', () => {
    expect(redis).toContain('redis-cli');
    for (const svc of ['api', 'worker']) {
      expect(serviceBlock(raw, svc)).toMatch(/condition:\s*service_healthy/);
    }
  });
});

describe('secrets', () => {
  const { raw, lines } = readCompose();

  it('are interpolated, never written in', () => {
    // Requirement: environment variables only, nothing hardcoded. Every
    // sensitive key must be a ${...} reference rather than a literal.
    const sensitive = /(PASS|PASSWORD|SECRET|TOKEN|_KEY|DSN|DATABASE_URL|JWT)/;
    const offenders = lines
      .filter((l) => /^\s+[A-Z_]+:\s*\S/.test(l))
      .filter((l) => sensitive.test(l.split(':')[0]))
      .filter((l) => !/\$\{/.test(l));
    expect(offenders).toEqual([]);
  });

  it('fails loudly on a missing required variable rather than starting blank', () => {
    // ${VAR} with no default aborts `docker compose up`; ${VAR:-} is the
    // marker for a genuinely optional one. Starting the API with a blank
    // DATABASE_URL is the failure mode this prevents.
    for (const key of ['DATABASE_URL', 'JWT_SECRET', 'FRONTEND_URL']) {
      expect(raw).toMatch(new RegExp(`${key}: \\$\\{${key}\\}`));
    }
  });
});
