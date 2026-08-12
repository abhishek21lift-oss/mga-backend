// Command Center — Phase 7: the AI Guardian.
//
// The failure this phase is designed against is a confident wrong answer.
//
// The demo-friendly build is: serialise the snapshot, hand it to a model, ask
// "what is wrong". It always answers — including when nothing is wrong, and
// including when the real cause is not in the data — and nothing in the output
// separates "found it" from "wrote something that reads like finding it".
//
// So the diagnosis is decided by rules that can be read and tested, and these
// tests are mostly about restraint:
//
//   * a rule must not fire on one card. A correlation across two cards is the
//     entire value of this layer; a rule reading one card is a threshold, and
//     the collector already owns thresholds.
//   * an UNKNOWN signal must never satisfy a trigger. "Redis is healthy" and
//     "we cannot see Redis" are different states, and conflating them is how an
//     engine confidently blames the worker on a box with no Redis configured.
//   * confidence must move with the evidence, and must never reach certainty.
//   * the model must not be able to change a diagnosis, a severity or a number.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const mockCollect = jest.fn();
const mockRoutedChat = jest.fn();

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../modules/command-center/snapshot.service', () => ({ collect: mockCollect }));
jest.mock('../lib/ai/router', () => ({ routedChat: mockRoutedChat }));

const guardian = require('../modules/command-center/guardian.service');
const { RULES } = require('../modules/command-center/guardian.rules');

/** A card in the collector's shape. */
function card(name, status, data = {}) {
  return { name, status, data, latency_ms: 1, reason: null, checked_at: '' };
}

function snapshotOf(cards) {
  return {
    status: 'warning',
    collected_at: new Date().toISOString(),
    duration_ms: 4,
    cards: Object.fromEntries(cards.map((c) => [c.name, c])),
  };
}

async function analyse(cards) {
  mockCollect.mockResolvedValueOnce(snapshotOf(cards));
  return guardian.analyse();
}

const find = (out, id) => out.findings.find((f) => f.id === id);

// Reusable healthy cards, so each test states only what it is varying.
const healthyRedis = () => card('redis', 'healthy', { memory: { used_ratio: 0.2, policy: 'noeviction' } });
const idleQueues = () => card('queues', 'healthy', { totals: { waiting: 0, active: 0, failed: 0 }, queues: [] });

beforeEach(() => jest.clearAllMocks());

// ── The layer's own boundary ────────────────────────────────────────────────
describe('what a rule is allowed to be', () => {
  test('every rule correlates across more than one card', () => {
    // A rule that reads a single card is a threshold wearing a hat, and the
    // collector already owns thresholds. Enforced structurally so the next
    // rule added cannot quietly be a duplicate of a collector's own grading.
    //
    // Signals name the cards they read via their test bodies, so the check is
    // on the source text — crude, but it fails loudly if a one-card rule
    // appears, which is the point.
    // Collected rather than asserted one at a time so the failure message
    // names which rule regressed and which single card it reads.
    const offenders = RULES.map((rule) => {
      const src = [...rule.triggers, ...(rule.corroborating ?? [])]
        .map((s) => s.test.toString()).join(' ');
      const cardsRead = new Set(
        [...src.matchAll(/(?:val|statusIs)\(c,\s*'([a-z]+)'/g)].map((m) => m[1]),
      );
      return cardsRead.size > 1 ? null : `${rule.id} reads only [${[...cardsRead]}]`;
    }).filter(Boolean);

    expect(offenders).toEqual([]);
  });

  test('every rule declares a conclusion an operator can act on', () => {
    for (const rule of RULES) {
      expect(typeof rule.conclusion).toBe('string');
      expect(rule.conclusion.length).toBeGreaterThan(40);
    }
    // Either a command that helps, or written advice. A rule that offers
    // neither has diagnosed nothing useful.
    const stepless = RULES
      .filter((r) => (r.recommend ?? []).length === 0 && typeof r.advice !== 'string')
      .map((r) => r.id);
    expect(stepless).toEqual([]);
  });
});

// ── Worker starvation: the flagship correlation ─────────────────────────────
describe('worker starvation', () => {
  test('fires when jobs wait, nothing is active, and Redis is fine', async () => {
    const out = await analyse([
      card('queues', 'critical', { totals: { waiting: 40, active: 0, failed: 0 }, queues: [{ name: 'email', starved: true }] }),
      healthyRedis(),
    ]);

    const f = find(out, 'worker.starvation');
    expect(f).toBeTruthy();
    // The misdiagnosis this rule exists to prevent, stated in the conclusion.
    expect(f.conclusion).toMatch(/worker/i);
    expect(f.recommend).toEqual(['queue.pause', 'queue.drain', 'queue.resume']);
    expect(f.recovery).toBe(true);
  });

  test('does NOT fire when jobs are actively being processed', async () => {
    const out = await analyse([
      card('queues', 'warning', { totals: { waiting: 40, active: 3, failed: 0 }, queues: [] }),
      healthyRedis(),
    ]);
    expect(find(out, 'worker.starvation')).toBeUndefined();
  });

  test('does NOT fire when the queue is simply empty', async () => {
    const out = await analyse([idleQueues(), healthyRedis()]);
    expect(find(out, 'worker.starvation')).toBeUndefined();
  });

  test('with Redis UNAVAILABLE it still fires — but with lower confidence, and says why', async () => {
    // The important case. "Redis is healthy" corroborates the worker theory;
    // "we cannot see Redis" does not refute it, but it does mean we know less.
    // An engine that treated unavailable as false would silently drop
    // confidence with no explanation; one that treated it as true would
    // overstate. It has to be a third thing.
    const withRedis = await analyse([
      card('queues', 'critical', { totals: { waiting: 40, active: 0, failed: 0 }, queues: [{ name: 'email', starved: true }] }),
      healthyRedis(),
    ]);
    const blind = await analyse([
      card('queues', 'critical', { totals: { waiting: 40, active: 0, failed: 0 }, queues: [{ name: 'email', starved: true }] }),
      card('redis', 'unavailable', null),
    ]);

    expect(blind.findings.find((f) => f.id === 'worker.starvation')).toBeTruthy();
    expect(find(blind, 'worker.starvation').confidence)
      .toBeLessThan(find(withRedis, 'worker.starvation').confidence);
    // And the gap is explained rather than merely reflected in the number.
    expect(find(blind, 'worker.starvation').evidence.unchecked.map((e) => e.key))
      .toContain('redis_answering');
  });

  test('an UNKNOWN trigger never satisfies the rule', async () => {
    // The queues card itself cannot be read. We do not get to conclude
    // anything about the worker — this is the case where a careless engine
    // invents findings on a box whose probes are not wired up.
    const out = await analyse([
      card('queues', 'unavailable', null),
      healthyRedis(),
    ]);
    expect(find(out, 'worker.starvation')).toBeUndefined();
  });
});

// ── Redis: the deployment-specific one ──────────────────────────────────────
describe('redis enqueue failure', () => {
  test('fires only when the policy is noeviction', async () => {
    const noevict = await analyse([
      card('redis', 'warning', { memory: { used_ratio: 0.9, policy: 'noeviction' } }),
      card('queues', 'healthy', { totals: { waiting: 5, active: 1, failed: 2 }, queues: [] }),
    ]);
    expect(find(noevict, 'redis.enqueue_failure_imminent')).toBeTruthy();

    // On an eviction policy the same memory figure is normal operation: Redis
    // drops keys and carries on. Alerting identically on both would be wrong.
    const evicting = await analyse([
      card('redis', 'warning', { memory: { used_ratio: 0.9, policy: 'allkeys-lru' } }),
      card('queues', 'healthy', { totals: { waiting: 5, active: 1, failed: 2 }, queues: [] }),
    ]);
    expect(find(evicting, 'redis.enqueue_failure_imminent')).toBeUndefined();
  });

  test('names the consequence in terms of the product, not of Redis', async () => {
    const out = await analyse([
      card('redis', 'warning', { memory: { used_ratio: 0.92, policy: 'noeviction' } }),
      card('queues', 'healthy', { totals: { waiting: 3, active: 1, failed: 0 }, queues: [] }),
    ]);
    expect(find(out, 'redis.enqueue_failure_imminent').conclusion)
      .toMatch(/membership renewal|email/i);
  });
});

// ── The one with no fix available ───────────────────────────────────────────
describe('mail silently discarded', () => {
  test('fires on the platform\'s actual state and offers no useless command', async () => {
    const out = await analyse([
      card('smtp', 'critical', { configured: true, delivery: { invitations_total: 2, invitations_sent: 0, attempted_never_sent: 1 } }),
      idleQueues(),
    ]);

    const f = find(out, 'mail.silently_discarded');
    expect(f).toBeTruthy();
    // Deliberately empty: no allow-listed command fixes a blocked SMTP port,
    // and offering one that cannot help is worse than offering none.
    expect(f.recommend).toEqual([]);
    // But there IS a real next step, and it is written down.
    expect(f.advice).toMatch(/RESEND_API_KEY/);
  });
});

// ── The anti-symptom-chasing rule ───────────────────────────────────────────
describe('slow API vs slow database', () => {
  test('blames the database when both are slow together', async () => {
    const out = await analyse([
      card('http', 'warning', { latency_ms: { p95: 2400 }, samples: 300 }),
      card('database', 'warning', { latency_ms: 400, slow_queries: [{ q: 'x' }], pool: {}, connections: {} }),
      card('runtime', 'healthy', { event_loop_lag_ms: { p99: 5 }, cpu_percent: 20 }),
    ]);

    const f = find(out, 'http.slow_because_database');
    expect(f).toBeTruthy();
    expect(f.conclusion).toMatch(/symptom/i);
  });

  test('a thin request sample is not enough to call the API slow', async () => {
    // Four requests cannot support a p95. Same restraint the http collector
    // applies to itself — the Guardian must not launder an ungraded number
    // into a confident diagnosis.
    const out = await analyse([
      card('http', 'healthy', { latency_ms: { p95: 9000 }, samples: 4 }),
      card('database', 'warning', { latency_ms: 400, slow_queries: [] }),
    ]);
    expect(find(out, 'http.slow_because_database')).toBeUndefined();
  });
});

describe('blocked event loop vs busy process', () => {
  test('high lag with LOW cpu is diagnosed as blocked, and says not to scale', async () => {
    const out = await analyse([
      card('runtime', 'warning', { event_loop_lag_ms: { p99: 400 }, cpu_percent: 12 }),
      card('http', 'warning', { latency_ms: { p95: 1500 }, samples: 200 }),
    ]);

    const f = find(out, 'runtime.event_loop_blocked');
    expect(f).toBeTruthy();
    expect(f.conclusion).toMatch(/synchronous/i);
    expect(f.advice).toMatch(/rather than scaling/i);
  });

  test('high lag with HIGH cpu is not this finding', async () => {
    // That process is genuinely busy. The fix is capacity, and pointing the
    // operator at synchronous code would waste the incident.
    const out = await analyse([
      card('runtime', 'warning', { event_loop_lag_ms: { p99: 400 }, cpu_percent: 95 }),
      card('http', 'warning', { latency_ms: { p95: 1500 }, samples: 200 }),
    ]);
    expect(find(out, 'runtime.event_loop_blocked')).toBeUndefined();
  });
});

// ── Confidence ──────────────────────────────────────────────────────────────
describe('confidence', () => {
  const starving = (extra = {}) => [
    card('queues', 'critical', {
      totals: { waiting: 40, active: 0, failed: 0 },
      queues: [{ name: 'email', starved: extra.starved ?? false }],
    }),
    extra.redis ?? healthyRedis(),
  ];

  test('rises as corroborating evidence fires', async () => {
    const weak = await analyse(starving({ starved: false }));
    const strong = await analyse(starving({ starved: true }));

    expect(find(strong, 'worker.starvation').confidence)
      .toBeGreaterThan(find(weak, 'worker.starvation').confidence);
  });

  test('never reaches certainty', async () => {
    // A rules engine that claims 100% about a system it sees through eight
    // sampled probes is lying. The cap is how the map admits it is not the
    // territory.
    const out = await analyse(starving({ starved: true }));
    expect(find(out, 'worker.starvation').confidence).toBeLessThanOrEqual(guardian.MAX_CONFIDENCE);
    expect(guardian.MAX_CONFIDENCE).toBeLessThan(1);
  });

  test('is never so low as to be meaningless once the triggers fired', async () => {
    // If all triggers fired, something real is happening. A 3% confidence
    // would be the engine disowning its own rule.
    const out = await analyse(starving({ redis: card('redis', 'unavailable', null), starved: false }));
    expect(find(out, 'worker.starvation').confidence).toBeGreaterThanOrEqual(0.2);
  });

  test('the evidence lists distinguish "not true" from "could not check"', async () => {
    const out = await analyse(starving({ redis: card('redis', 'unavailable', null), starved: false }));
    const e = find(out, 'worker.starvation').evidence;

    // starved_flag was checked and was false; redis_answering could not be
    // checked at all. Collapsing these into one list is how a console starts
    // overstating what it knows.
    expect(e.absent.map((x) => x.key)).toContain('starved_flag');
    expect(e.unchecked.map((x) => x.key)).toContain('redis_answering');
    expect(e.absent.map((x) => x.key)).not.toContain('redis_answering');
  });

  test('every trigger appears in the evidence, so the number is checkable', async () => {
    const out = await analyse(starving({ starved: true }));
    const f = find(out, 'worker.starvation');
    expect(f.evidence.triggers.map((t) => t.key)).toEqual(['jobs_waiting', 'nothing_active']);
    // And each carries a readable detail, not just a key.
    for (const t of f.evidence.triggers) expect(typeof t.detail).toBe('string');
  });
});

// ── Nothing wrong ───────────────────────────────────────────────────────────
describe('a healthy platform', () => {
  test('produces no findings, and says the rules ran', async () => {
    const out = await analyse([
      idleQueues(), healthyRedis(),
      card('runtime', 'healthy', { event_loop_lag_ms: { p99: 3 }, cpu_percent: 8 }),
      card('database', 'healthy', { latency_ms: 12, pool: { waiting: 0 }, connections: { idle_in_transaction: 0 } }),
      card('http', 'healthy', { latency_ms: { p95: 90 }, samples: 400 }),
      card('smtp', 'healthy', { configured: true, delivery: { invitations_total: 4, invitations_sent: 4, attempted_never_sent: 0 } }),
    ]);

    expect(out.findings).toHaveLength(0);
    // "The rules ran and matched nothing" is a different claim from "the
    // Guardian did not run", and the operator is told which.
    expect(out.note).toMatch(/none matched/i);
    expect(out.rules_evaluated).toBe(RULES.length);
  });

  test('an empty snapshot produces no findings rather than guesses', async () => {
    const out = await analyse([]);
    expect(out.findings).toHaveLength(0);
  });

  test('a snapshot failure is reported, not thrown', async () => {
    mockCollect.mockRejectedValueOnce(new Error('collector exploded'));
    const out = await guardian.analyse();
    expect(out.findings).toHaveLength(0);
    expect(out.note).toMatch(/exploded/);
  });
});

// ── Narration: the model stays in its lane ──────────────────────────────────
describe('AI narration', () => {
  const starvedCards = [
    card('queues', 'critical', { totals: { waiting: 40, active: 0, failed: 0 }, queues: [{ name: 'email', starved: true }] }),
    healthyRedis(),
  ];

  test('the model is given the FINDING, never the raw snapshot', async () => {
    // The core safety property. A model handed raw metrics will produce a
    // plausible diagnosis of its own; handed a finished finding it can only
    // reword one this codebase already stands behind.
    mockRoutedChat.mockResolvedValueOnce({ content: 'Restart the worker first.', model: 'm' });
    mockCollect.mockResolvedValueOnce(snapshotOf(starvedCards));

    await guardian.explain('worker.starvation');

    const prompt = mockRoutedChat.mock.calls[0][0].messages[0].content;
    expect(prompt).toMatch(/DIAGNOSIS/);
    expect(prompt).toMatch(/do not change it/i);
    // No serialised card payload of any kind.
    expect(prompt).not.toMatch(/latency_ms|checked_at|"data"|used_ratio/);
  });

  test('the narration cannot alter the diagnosis, severity or confidence', async () => {
    mockRoutedChat.mockResolvedValueOnce({
      content: 'Actually the database is the problem and I am 100% certain.',
      model: 'm',
    });
    mockCollect.mockResolvedValueOnce(snapshotOf(starvedCards));
    const narrated = await guardian.explain('worker.starvation');

    // Whatever the model said, the finding is unchanged — the narration is a
    // separate payload, not an edit.
    expect(narrated.narration).toMatch(/Actually the database/);
    const out = await analyse(starvedCards);
    const f = find(out, 'worker.starvation');
    expect(f.severity).toBe('critical');
    expect(f.confidence).toBeLessThanOrEqual(guardian.MAX_CONFIDENCE);
    expect(f.conclusion).toMatch(/worker/i);
  });

  test('a failing model leaves the finding intact and says narration is unavailable', async () => {
    // The deterministic text is the product. The narration is a garnish, and a
    // garnish must not be able to break the plate.
    mockRoutedChat.mockRejectedValueOnce(new Error('no API key'));
    mockCollect.mockResolvedValueOnce(snapshotOf(starvedCards));

    const out = await guardian.explain('worker.starvation');
    expect(out.narration).toBeNull();
    expect(out.unavailable_reason).toMatch(/no API key/);
  });

  test('narrating a finding that is not active 404s rather than inventing one', async () => {
    mockCollect.mockResolvedValueOnce(snapshotOf([idleQueues(), healthyRedis()]));
    await expect(guardian.explain('worker.starvation')).rejects.toMatchObject({ status: 404 });
    expect(mockRoutedChat).not.toHaveBeenCalled();
  });

  test('the read path never calls the model', async () => {
    // analyse() is polled by the console. Narrating on every tick would spend
    // tokens restating text already on screen.
    await analyse(starvedCards);
    expect(mockRoutedChat).not.toHaveBeenCalled();
  });

  test('narration is labelled as generated', async () => {
    mockRoutedChat.mockResolvedValueOnce({ content: 'text', model: 'm' });
    mockCollect.mockResolvedValueOnce(snapshotOf(starvedCards));
    const out = await guardian.explain('worker.starvation');
    // An operator must always be able to tell which sentence a machine wrote.
    expect(out.generated).toBe(true);
  });
});
