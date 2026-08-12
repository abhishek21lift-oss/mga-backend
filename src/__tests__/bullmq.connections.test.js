// Every BullMQ object gets its connection from lib/redis.js, and nowhere else.
//
// ── The production bug this exists to prevent ───────────────────────────────
//
// src/jobs/email.queue.js built a Queue with `connection: redis` — the lib/redis
// MODULE OBJECT, where BullMQ expects an ioredis client or {host, port}. The
// module has no `host` key, so BullMQ constructed its own driver from nothing
// and ioredis fell back to its default, 127.0.0.1:6379.
//
// On the VPS the API runs in its own container with REDIS_HOST=redis, and Redis
// is a different container, so 127.0.0.1 is the API's own loopback where nothing
// listens. The logs carried a permanent
//
//     ECONNREFUSED 127.0.0.1:6379
//
// three connections' worth per boot, from a queue nothing used — the only caller
// was /api/debug, which 404s in production. The environment was correct
// throughout; a single call site passed the wrong KIND of argument.
//
// ── Why this test is a static scan ──────────────────────────────────────────
//
// A runtime test only covers files it happens to import, and the whole reason
// the bug survived is that nothing imported that file in anger. Scanning the
// source catches the NEXT one too, which is the point: six call sites were
// correct and one was not, and there was no mechanism that could tell.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');

/** The only two acceptable ways to hand a connection to BullMQ. */
const APPROVED = [
  'redis.getConnection()',        // producers — one shared non-blocking client
  'redis.getWorkerConnection()',  // consumers — their own blocking client
];

/** Every .js under src/, excluding tests. */
function sourceFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(p, acc);
    } else if (entry.name.endsWith('.js')) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Find every BullMQ construction and the `connection:` it was given.
 *
 * Reads the 6 lines after the constructor rather than parsing an AST: every
 * construction in this repo puts `connection:` on the first line of its options
 * object, and a rule nobody can read is a rule that gets deleted.
 */
function bullmqConstructions() {
  const found = [];
  const ctor = /new\s+(Queue|Worker|QueueEvents|QueueScheduler|FlowProducer)\s*\(/;

  for (const file of sourceFiles(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = ctor.exec(line);
      if (!m) return;
      const window = lines.slice(i, i + 6).join('\n');
      const conn = /connection\s*:\s*([^,\n]+)/.exec(window);
      found.push({
        file: path.relative(SRC, file),
        line: i + 1,
        kind: m[1],
        connection: conn ? conn[1].trim() : null,
      });
    });
  }
  return found;
}

describe('BullMQ connections', () => {
  const constructions = bullmqConstructions();

  it('finds the constructions, so this cannot pass vacuously', () => {
    // If a refactor renames things and this drops to zero, the suite would go
    // green while enforcing nothing at all.
    expect(constructions.length).toBeGreaterThanOrEqual(6);
  });

  it('gives every Queue, Worker and QueueEvents an approved connection', () => {
    // Named individually rather than counted: the failure message should say
    // which file reintroduced the bug and what it passed instead.
    const offenders = constructions
      .filter((c) => !APPROVED.includes(c.connection))
      .map((c) => `${c.file}:${c.line} — new ${c.kind}(...) got connection: ${c.connection ?? '(none)'}`);

    expect(offenders).toEqual([]);
  });

  it('has no construction without a connection at all', () => {
    // Omitting `connection` entirely is the same bug by a shorter route:
    // BullMQ builds its own driver and ioredis defaults to 127.0.0.1:6379.
    const missing = constructions
      .filter((c) => c.connection === null)
      .map((c) => `${c.file}:${c.line}`);

    expect(missing).toEqual([]);
  });
});

describe('why `connection: redis` is the bug', () => {
  // The static rule above is only defensible if the reason is written down and
  // checked. These two assertions ARE the reason.

  it('the lib/redis module object is not valid ConnectionOptions', () => {
    process.env.REDIS_HOST = 'redis';
    jest.isolateModules(() => {
      const redis = require('../lib/redis');

      // This is exactly what made `connection: redis` fail: BullMQ accepts the
      // object, finds no host, and lets ioredis default to loopback. Nothing
      // throws, nothing warns — it just dials the wrong address forever.
      expect('host' in redis).toBe(false);
      expect('port' in redis).toBe(false);

      // The functions that DO return something usable.
      expect(typeof redis.getConnection).toBe('function');
      expect(typeof redis.getWorkerConnection).toBe('function');
    });
  });

  it('lib/redis never resolves to loopback, even with nothing configured', () => {
    // The other half of the guard. If DEFAULT_HOST were ever changed to
    // localhost, every container would look healthy in development and fail
    // identically in production — the same symptom from the opposite cause.
    const saved = { ...process.env };
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;

    jest.isolateModules(() => {
      const { redisOptions } = require('../lib/redis');
      expect(redisOptions.host).not.toBe('127.0.0.1');
      expect(redisOptions.host).not.toBe('localhost');
      // The compose service name, which is what resolves inside the network.
      expect(redisOptions.host).toBe('redis');
    });

    process.env = saved;
  });

  it('REDIS_HOST is honoured when set', () => {
    const saved = { ...process.env };
    delete process.env.REDIS_URL;
    process.env.REDIS_HOST = 'some-other-host';
    process.env.REDIS_PORT = '6380';

    jest.isolateModules(() => {
      const { redisOptions } = require('../lib/redis');
      expect(redisOptions.host).toBe('some-other-host');
      expect(redisOptions.port).toBe(6380);
    });

    process.env = saved;
  });

  it('REDIS_URL wins over REDIS_HOST — worth knowing before debugging one', () => {
    // Not a bug, but a real trap: setting REDIS_HOST while a stale REDIS_URL is
    // still in the environment looks like REDIS_HOST being ignored. Pinned so
    // the precedence is a documented decision rather than a surprise.
    const saved = { ...process.env };
    process.env.REDIS_HOST = 'redis';
    process.env.REDIS_URL = 'redis://elsewhere:6390';

    jest.isolateModules(() => {
      const { redisOptions } = require('../lib/redis');
      expect(redisOptions.host).toBe('elsewhere');
      expect(redisOptions.port).toBe(6390);
    });

    process.env = saved;
  });
});
