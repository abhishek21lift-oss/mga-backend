// Command Center — Phase 8: Live Logs (decision D4).
//
// ── The bug this phase is mostly written to avoid ───────────────────────────
//
// Persisting error logs to the database means that when the database is
// unhealthy, the INSERT fails. The obvious thing to do with a failed INSERT is
// log an error — which is at error level, so it is captured, so it is queued,
// so it fails, so it logs an error.
//
// That loop pins the CPU and floods the disk during exactly the incident the
// feature exists to investigate. Three guards are tested here, because any one
// of them alone is not enough.
//
// The other theme is that logging must never be able to break the thing being
// logged: `accept()` runs synchronously inside pino, on the request path, so a
// malformed line, a huge line or a throw inside the capture must all be
// survivable.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const mockPoolQuery = jest.fn(async () => ({ rows: [], rowCount: 0 }));
jest.mock('../db/pool', () => ({ query: mockPoolQuery }));

const buffer = require('../modules/command-center/logBuffer');
const capture = require('../modules/command-center/logCapture');

/** A pino-shaped line. */
function line(level, msg, extra = {}) {
  return JSON.stringify({
    level, time: Date.now(), pid: 42, hostname: 'vm', msg, ...extra,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  capture._reset();
});

// ── The ring ────────────────────────────────────────────────────────────────
describe('the in-memory ring', () => {
  test('holds recent lines and returns them newest first', () => {
    for (let i = 1; i <= 5; i++) capture.accept(line(30, `line ${i}`));
    const out = buffer.tail();

    expect(out).toHaveLength(5);
    expect(out[0].msg).toBe('line 5');
    expect(out[4].msg).toBe('line 1');
  });

  test('is bounded — memory does not grow with traffic', () => {
    const n = buffer.CAPACITY + 500;
    for (let i = 0; i < n; i++) capture.accept(line(30, `line ${i}`));

    const s = buffer.stats();
    expect(s.held).toBe(buffer.CAPACITY);
    // total_recorded keeps counting so the console can show throughput even
    // though only CAPACITY lines are retained.
    expect(s.total_recorded).toBe(n);
    // Overwriting the oldest entry is what a ring IS. Counting it as a drop
    // would report a fault where there is only a design.
    expect(s.dropped).toBe(0);
  });

  test('filters by level floor', () => {
    capture.accept(line(20, 'debug line'));
    capture.accept(line(30, 'info line'));
    capture.accept(line(50, 'error line'));

    const warnUp = buffer.tail({ minLevel: 40 });
    expect(warnUp.map((l) => l.msg)).toEqual(['error line']);
  });

  test('filters by substring and by since, so polling is cheap', () => {
    capture.accept(line(30, 'renewal job started'));
    capture.accept(line(30, 'email sent'));

    expect(buffer.tail({ q: 'renewal' })).toHaveLength(1);
    // `since` is what lets the console poll without re-shipping the window.
    expect(buffer.tail({ since: Date.now() + 1000 })).toHaveLength(0);
  });

  test('keeps context fields separate from the message', () => {
    capture.accept(line(50, 'queue failed', { queue: 'email', err: 'ECONNREFUSED' }));
    const [entry] = buffer.tail();

    expect(entry.msg).toBe('queue failed');
    expect(entry.context).toEqual({ queue: 'email', err: 'ECONNREFUSED' });
  });
});

// ── Never break the logger ──────────────────────────────────────────────────
describe('capture cannot break the thing it is capturing', () => {
  test('a non-JSON line is kept, not dropped', async () => {
    // Something wrote to the stream directly. During an incident an
    // unparseable line is still evidence.
    capture.accept('this is not json at all');
    expect(buffer.tail()[0].msg).toBe('this is not json at all');
  });

  test('the stream never throws back into pino', () => {
    // accept() runs inside the logger. An exception here would propagate into
    // whatever was being logged, turning a log statement into a crash.
    expect(() => {
      capture.stream.write(Buffer.from('{"level":'), 'utf8', () => {});
      capture.stream.write(Buffer.from(''), 'utf8', () => {});
    }).not.toThrow();
  });

  test('a line with no msg is still recorded', () => {
    capture.accept(JSON.stringify({ level: 50, time: Date.now(), err: 'boom' }));
    expect(buffer.tail()).toHaveLength(1);
  });
});

// ── Redaction ───────────────────────────────────────────────────────────────
describe('scrubbing secrets that pino\'s path redaction cannot reach', () => {
  // lib/logger.js redacts by PATH — authorization headers, passwords, emails.
  // That covers structured fields and misses a secret sitting inside a free
  // text message. This feature changes the exposure of those: a line that used
  // to go to a VPS's stdout is now stored in a table and rendered in a browser.

  test('a connection string loses its password', () => {
    capture.accept(line(50, 'connect failed: postgres://admin:hunter2@db.internal:5432/app'));
    const [entry] = buffer.tail();

    expect(entry.msg).not.toMatch(/hunter2/);
    expect(entry.msg).toMatch(/\[REDACTED\]/);
    // The rest survives — a redaction that ate the hostname would destroy the
    // reason the line is useful.
    expect(entry.msg).toMatch(/db\.internal/);
  });

  test('bearer tokens and JWTs are masked', () => {
    capture.accept(line(50, 'rejected Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123'));
    expect(buffer.tail()[0].msg).not.toMatch(/eyJhbGci/);
  });

  test('provider keys are masked by prefix', () => {
    capture.accept(line(50, 'resend rejected key re_AbCdEf123456789'));
    const msg = buffer.tail()[0].msg;
    expect(msg).not.toMatch(/AbCdEf123456789/);
    // Enough is left to identify WHICH kind of key, which is the diagnostic bit.
    expect(msg).toMatch(/re_\[REDACTED\]/);
  });

  test('scrubbing reaches into context, not just the message', () => {
    capture.accept(line(50, 'boom', { err: 'auth to postgres://u:secretpw@h/db failed' }));
    expect(JSON.stringify(buffer.tail()[0].context)).not.toMatch(/secretpw/);
  });

  test('ordinary text is left alone', () => {
    const msg = 'membership renewal completed for 42 clients in 1.2s';
    capture.accept(line(30, msg));
    expect(buffer.tail()[0].msg).toBe(msg);
  });
});

// ── What reaches Postgres ───────────────────────────────────────────────────
describe('persistence', () => {
  test('only error and above is queued — info never touches the database', async () => {
    // Writing a row for every log line would be a tax on the database, paid
    // forever, to store text that is interesting for four minutes.
    for (let i = 0; i < 50; i++) capture.accept(line(30, `info ${i}`));
    expect(capture.stats().pending).toBe(0);

    await capture.flush();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('errors and fatals are queued and written in ONE statement', async () => {
    capture.accept(line(50, 'error one'));
    capture.accept(line(60, 'fatal one'));
    expect(capture.stats().pending).toBe(2);

    const out = await capture.flush();

    expect(out.written).toBe(2);
    // A row-per-INSERT would multiply round trips at exactly the moment the
    // database is the thing under strain.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/INSERT INTO system_logs/);
  });

  test('the row records which process wrote it', async () => {
    capture.accept(line(50, 'worker exploded'));
    await capture.flush();

    const params = mockPoolQuery.mock.calls[0][1];
    // Without this column an operator sees no worker lines in the live tail
    // and concludes the worker is not logging — when its lines are in this
    // table and nowhere else.
    expect(params).toContain(capture.SOURCE);
  });

  test('a flush with nothing pending does not hit the database', async () => {
    await capture.flush();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('flushing is batched, so one burst cannot build a giant statement', async () => {
    for (let i = 0; i < capture.FLUSH_BATCH + 20; i++) capture.accept(line(50, `err ${i}`));
    const out = await capture.flush();

    expect(out.written).toBe(capture.FLUSH_BATCH);
    expect(capture.stats().pending).toBe(20);
  });
});

// ── The loop, and the three guards ──────────────────────────────────────────
describe('a failing database cannot start a feedback loop', () => {
  test('a failed flush reports to stderr, NEVER through the logger', async () => {
    // GUARD 2. Calling logger.error here is the loop: the logger feeds this
    // module. Asserted against the real stderr, because the whole point is
    // that this path bypasses the logging stack entirely.
    const writes = [];
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });

    mockPoolQuery.mockRejectedValueOnce(new Error('connection refused'));
    capture.accept(line(50, 'something broke'));
    const out = await capture.flush();

    expect(out.written).toBe(0);
    expect(writes.join('')).toMatch(/could not persist/);
    // And crucially: the failure did not itself become a queued line.
    expect(capture.stats().pending).toBe(0);

    spy.mockRestore();
  });

  test('a line emitted DURING a flush is not queued by that flush', async () => {
    // GUARD 1, the re-entrancy flag. Simulated by logging from inside the
    // query, which is exactly what a logging database driver would do.
    mockPoolQuery.mockImplementationOnce(async () => {
      capture.accept(line(50, 'error raised while flushing'));
      return { rows: [], rowCount: 1 };
    });

    capture.accept(line(50, 'the original error'));
    await capture.flush();

    // The nested line is in the ring — it is still a real log line — but it
    // was not added to the pending queue, which is what would recurse.
    expect(buffer.tail().some((l) => l.msg === 'error raised while flushing')).toBe(true);
    expect(capture.stats().pending).toBe(0);
  });

  test('a database that stays down costs a fixed amount of memory', async () => {
    // GUARD 3. Without a bound, an outage of any length ends in an OOM — and
    // the process dies of the monitoring rather than of the problem.
    mockPoolQuery.mockRejectedValue(new Error('still down'));
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    for (let i = 0; i < capture.MAX_PENDING + 200; i++) capture.accept(line(50, `err ${i}`));

    const s = capture.stats();
    expect(s.pending).toBeLessThanOrEqual(capture.MAX_PENDING);
    // Dropped lines are counted rather than silently discarded — the console
    // shows the number, so the gap in the record is visible.
    expect(s.dropped_pending).toBeGreaterThan(0);
    expect(buffer.stats().dropped).toBeGreaterThan(0);

    spy.mockRestore();
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  test('dropping under pressure never loses the line from the RING', async () => {
    // The ring is memory-only and always accepts. Even when the database is
    // unreachable, the live tail still works — which is the half of D4 that
    // does not depend on anything.
    mockPoolQuery.mockRejectedValue(new Error('down'));
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    for (let i = 0; i < capture.MAX_PENDING + 50; i++) capture.accept(line(50, `err ${i}`));
    expect(buffer.tail({ limit: 10 })).toHaveLength(10);

    spy.mockRestore();
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });
});

// ── Retention ───────────────────────────────────────────────────────────────
describe('retention', () => {
  test('prune deletes by age and reports the count', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 17 });
    const removed = await capture.prune(30);

    expect(removed).toBe(17);
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/DELETE FROM system_logs/);
    // The window is a parameter, not string-interpolated into the interval.
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['30']);
  });

  test('a failed prune is survivable and does not go through the logger', async () => {
    const writes = [];
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });

    mockPoolQuery.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(capture.prune()).resolves.toBe(0);
    expect(writes.join('')).toMatch(/retention sweep failed/);

    spy.mockRestore();
  });

  test('the retention window is never zero or negative', async () => {
    // A misconfigured LOG_RETENTION_DAYS=0 would delete the table's contents on
    // the next sweep, including the lines being looked at.
    await capture.prune(0);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['1']);
  });
});
