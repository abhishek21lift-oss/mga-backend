// The AI coach — everything except the model call.
//
// The network part is not the risky part. The risky parts are what goes INTO
// the prompt and what is allowed back OUT of it, and both are pure functions
// here precisely so they can be tested without an API key.
//
// The failure this guards against is not a crash. It is a model writing
// "nutrition compliance is slipping" for a client who has never logged a meal,
// in a confident voice, next to figures that are real — and a trainer changing
// a programme that was working. Everything below is about making that hard.

const {
  generateCoach, buildFacts, parseInsights, factsKey, SYSTEM_PROMPT,
} = require('../modules/pt-os/coach-ai');

const CLIENT = { name: 'Ratnam Yadav', age: 25, gender: 'Male' };

const SNAPSHOT = {
  alerts: [
    { id: 'sleep', severity: 'warning', label: 'Sleep poor', detail: '6 h a night' },
    { id: 'missed_workout', severity: 'warning', label: 'Missed last workout', detail: '2026-07-28' },
  ],
  goal: { present: true, goal_type: 'weight_loss', target_kg: 70, current_kg: 73.2, start_kg: 80, pct: 68 },
  prs: [{ exercise: 'Bench Press', weight_kg: 85, reps: 3, achieved_on: '2026-07-20' }],
  coach: [],
};

const BRIEF = {
  missing: ['body', 'history'],
  sections: {
    readiness: { present: true, risk_level: 'low', gate_status: 'cleared' },
    lifestyle: { present: true, sleep_hours: 6, sleep_quality: 8, stress_level: 5, recovery_quality: 'average' },
    limitations: {
      present: true,
      mobility: { findings: [{ region: 'Neck', pain: true, restriction: true }] },
      injuries: null,
    },
  },
};

const DERIVED = [{ id: 'recovery', tone: 'warn', text: 'Recovery is low.', because: 'Lifestyle assessment' }];

describe('buildFacts — the prompt carries the gaps, not just the readings', () => {
  const facts = buildFacts({ snapshot: SNAPSHOT, brief: BRIEF, client: CLIENT });

  it('includes the readings that exist', () => {
    expect(facts).toContain('Ratnam Yadav');
    expect(facts).toContain('target 70 kg');
    expect(facts).toContain('Bench Press: 85 kg × 3');
    expect(facts).toContain('Neck: pain + restricted');
  });

  it('names what has NOT been measured, and forbids commenting on it', () => {
    // Without this section the model assumes the unmeasured things are fine,
    // or invents a figure — which is the whole failure mode.
    expect(facts).toMatch(/NOT MEASURED/);
    expect(facts).toMatch(/must not assume they are fine/);
    expect(facts).toContain('no meals logged');
    expect(facts).toContain('no weekly check-ins');
  });

  it('carries the brief\'s own missing list through', () => {
    expect(facts).toContain('- body');
    expect(facts).toContain('- history');
  });

  it('says a goal with no baseline has no percentage, rather than omitting it', () => {
    const f = buildFacts({
      snapshot: { ...SNAPSHOT, goal: { present: true, goal_type: 'weight_loss', target_kg: 70, pct: null } },
      brief: BRIEF, client: CLIENT,
    });
    expect(f).toMatch(/no baseline on file, so no percentage/);
  });

  it('says so plainly when there is no goal at all', () => {
    const f = buildFacts({ snapshot: { ...SNAPSHOT, goal: { present: false } }, brief: BRIEF, client: CLIENT });
    expect(f).toContain('GOAL: none set.');
  });

  it('survives an empty client with no snapshot and no brief', () => {
    expect(() => buildFacts({ snapshot: null, brief: null, client: null })).not.toThrow();
    expect(buildFacts({ snapshot: null, brief: null, client: null })).toContain('NOT MEASURED');
  });
});

describe('SYSTEM_PROMPT — the rules that matter are stated', () => {
  it('forbids inventing, requires citation, and rules out medical advice', () => {
    expect(SYSTEM_PROMPT).toMatch(/[Nn]ever state a fact that is not in the readings/);
    expect(SYSTEM_PROMPT).toMatch(/cite the reading/);
    expect(SYSTEM_PROMPT).toMatch(/no medical advice/i);
  });
});

describe('parseInsights — what is allowed back out', () => {
  it('reads a clean reply', () => {
    const out = parseInsights('{"insights":[{"tone":"warn","text":"Cut accessory volume.","because":"Lifestyle · recovery"}]}');
    expect(out).toEqual([{ id: 'ai-0', tone: 'warn', text: 'Cut accessory volume.', because: 'Lifestyle · recovery', source: 'ai' }]);
  });

  it('digs the JSON out of prose and fences, which models add unasked', () => {
    const wrapped = 'Sure! Here you go:\n```json\n{"insights":[{"tone":"good","text":"Bench is moving.","because":"Workout log"}]}\n```\nHope that helps.';
    expect(parseInsights(wrapped)).toHaveLength(1);
  });

  it('DROPS any line with no citation', () => {
    // The uncited line is the invented one. This is the single most important
    // assertion in the file.
    const out = parseInsights(JSON.stringify({
      insights: [
        { tone: 'warn', text: 'Nutrition compliance is slipping.' },
        { tone: 'warn', text: 'Sleep is short.', because: 'Lifestyle assessment' },
      ],
    }));
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('Sleep is short.');
  });

  it('drops blank text and whitespace-only citations', () => {
    expect(parseInsights('{"insights":[{"text":"   ","because":"x"},{"text":"y","because":"  "}]}')).toEqual([]);
  });

  it('caps the list rather than rendering an essay', () => {
    const many = { insights: Array.from({ length: 12 }, (_, i) => ({ text: `t${i}`, because: 'r' })) };
    expect(parseInsights(JSON.stringify(many))).toHaveLength(5);
  });

  it('returns nothing for junk instead of throwing', () => {
    for (const junk of ['', 'no json here', '{broken', null, undefined, 42, '{"insights":"nope"}']) {
      expect(parseInsights(junk)).toEqual([]);
    }
  });

  it('normalises an unknown tone to warn rather than passing it through', () => {
    expect(parseInsights('{"insights":[{"tone":"catastrophic","text":"t","because":"r"}]}')[0].tone).toBe('warn');
  });
});

describe('factsKey — cached against the readings, not the page view', () => {
  it('is stable for identical facts and changes when they do', () => {
    const a = buildFacts({ snapshot: SNAPSHOT, brief: BRIEF, client: CLIENT });
    const b = buildFacts({ snapshot: { ...SNAPSHOT, prs: [] }, brief: BRIEF, client: CLIENT });
    expect(factsKey(a)).toBe(factsKey(a));
    expect(factsKey(a)).not.toBe(factsKey(b));
  });
});

describe('generateCoach', () => {
  const args = { snapshot: SNAPSHOT, brief: BRIEF, client: CLIENT, fallback: DERIVED };

  it('returns the model\'s insights when they obey the contract', async () => {
    const chat = jest.fn().mockResolvedValue({
      content: '{"insights":[{"tone":"warn","text":"Drop one accessory.","because":"Lifestyle · recovery"}]}',
      model: 'test-model',
    });
    const out = await generateCoach({ ...args, chat });
    expect(out.source).toBe('ai');
    expect(out.insights[0].text).toBe('Drop one accessory.');
    expect(out.model).toBe('test-model');
  });

  it('sends the facts and the rules, and asks for low temperature', async () => {
    const chat = jest.fn().mockResolvedValue({ content: '{"insights":[]}' });
    await generateCoach({ ...args, chat });
    const call = chat.mock.calls[0][0];
    expect(call.messages[0].content).toBe(SYSTEM_PROMPT);
    expect(call.messages[1].content).toContain('NOT MEASURED');
    expect(call.temperature).toBeLessThanOrEqual(0.3);   // interpretation, not invention
    expect(call.intent).toBe('coaching');
  });

  it('falls back to the derived prompts when every model is down', async () => {
    // A card that vanishes when the API does teaches the trainer not to trust
    // it. The rule-based lines are true whatever the model did.
    const chat = jest.fn().mockRejectedValue(new Error('ALL_MODELS_FAILED'));
    const out = await generateCoach({ ...args, chat });
    expect(out.source).toBe('derived');
    expect(out.insights).toEqual(DERIVED);
  });

  it('falls back when the model replies with nothing usable', async () => {
    const chat = jest.fn().mockResolvedValue({ content: 'I could not determine anything.' });
    const out = await generateCoach({ ...args, chat });
    expect(out.source).toBe('derived');
    expect(out.insights).toEqual(DERIVED);
  });

  it('never returns an uncited line, whatever the model says', async () => {
    const chat = jest.fn().mockResolvedValue({
      content: '{"insights":[{"tone":"warn","text":"Protein intake is below target."}]}',
    });
    const out = await generateCoach({ ...args, chat });
    // "Protein intake" is unmeasurable here — no meal has ever been logged —
    // and the model volunteered it anyway. It must not reach the trainer.
    expect(out.insights.every((i) => i.because)).toBe(true);
    expect(JSON.stringify(out.insights)).not.toMatch(/Protein intake/);
  });
});
