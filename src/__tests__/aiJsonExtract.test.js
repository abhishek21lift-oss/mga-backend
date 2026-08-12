// Tests for extractJson/repairTruncatedJson (src/lib/ai/jsonExtract.js).
//
// This is what turns a model's raw text completion into the structured plan
// every AI feature actually uses. The failure mode worth guarding against:
// the diet schema (meals[].foods[] + grocery_list + supplements) is far more
// token-hungry than the workout schema, so it hits max_tokens and gets cut
// off mid-object noticeably more often — which used to mean the whole
// generation was thrown away with "Could not parse AI response as JSON"
// even though most of the plan had actually completed.
'use strict';

const { extractJson, repairTruncatedJson } = require('../lib/ai/jsonExtract');

describe('extractJson', () => {
  test('parses a clean JSON object as-is', () => {
    const obj = { name: 'Plan', meals: [{ name: 'Breakfast' }] };
    expect(extractJson(JSON.stringify(obj))).toEqual(obj);
  });

  test('strips markdown code fences the model adds despite being told not to', () => {
    const obj = { name: 'Plan' };
    expect(extractJson('```json\n' + JSON.stringify(obj) + '\n```')).toEqual(obj);
  });

  test('finds the JSON object even with prose wrapped around it', () => {
    const obj = { name: 'Plan' };
    expect(extractJson(`Here is your plan:\n${JSON.stringify(obj)}\nEnjoy!`)).toEqual(obj);
  });

  test('stops at the FIRST balanced object, not the last closing brace in the text', () => {
    // A greedy first-{ to last-} regex would swallow the trailing prose or a
    // second object into the match and fail to parse.
    const obj = { name: 'Plan' };
    const text = `${JSON.stringify(obj)}\n\nNote: this is a general plan, not medical advice. {see disclaimer}`;
    expect(extractJson(text)).toEqual(obj);
  });

  test('garbage text with no JSON at all returns null, not a crash', () => {
    expect(extractJson('I cannot help with that request.')).toBeNull();
  });

  test('empty/undefined input returns null', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson(undefined)).toBeNull();
  });

  // ── Truncation repair — the actual bug ──────────────────────────────────

  test('recovers a plan truncated mid-array (hit max_tokens after two of four meals)', () => {
    const truncated = '{"name":"Cut Plan","meals":[{"name":"Breakfast","calories":400},{"name":"Lunch","calories":600}';
    const result = extractJson(truncated);
    expect(result).toEqual({
      name: 'Cut Plan',
      meals: [{ name: 'Breakfast', calories: 400 }, { name: 'Lunch', calories: 600 }],
    });
  });

  test('recovers a plan truncated after closing a nested array, before the next field', () => {
    // meals[] completed in full; grocery_list started as a key but the value
    // never arrived — this is exactly the diet schema's shape when the
    // budget runs out between sections.
    const truncated = '{"name":"Cut Plan","meals":[{"name":"Breakfast"}],"grocery_lis';
    const result = extractJson(truncated);
    expect(result).toEqual({ name: 'Cut Plan', meals: [{ name: 'Breakfast' }] });
  });

  test('drops a dangling trailing comma before closing, rather than producing invalid JSON', () => {
    const truncated = '{"name":"Cut Plan","meals":[{"name":"Breakfast"},{"name":"Lunch"},';
    const result = extractJson(truncated);
    expect(result).toEqual({ name: 'Cut Plan', meals: [{ name: 'Breakfast' }, { name: 'Lunch' }] });
  });

  test('never treats a truncated KEY as a safe cut point — no dangling key in the output', () => {
    // Cut off right after the closing quote of "b" — which is a KEY, not a
    // completed value. A naive "safe after any closed string" rule would
    // produce {"a":"hello","b"} — invalid JSON. This must back up further.
    const truncated = '{"a":"hello","b';
    const result = extractJson(truncated);
    expect(result).toEqual({ a: 'hello' });
  });

  test('multi-level nesting closes in the correct order (innermost first)', () => {
    const truncated = '{"plan":{"days":[{"exercises":[{"name":"Squat","sets":3}';
    const result = extractJson(truncated);
    expect(result).toEqual({ plan: { days: [{ exercises: [{ name: 'Squat', sets: 3 }] }] } });
  });

  test('truncated with nothing safely closed yet returns null rather than an empty shell', () => {
    // Cut off before any element, key, or nested structure ever completed —
    // there's nothing worth salvaging.
    expect(extractJson('{"name":"Cut Plan","meals":[{"name":"Bre')).toBeNull();
  });

  test('a value truncated mid-string (not mid-key) is also excluded, not guessed at', () => {
    // The unclosed string starting at "Break is never marked safe, so the
    // repair backs up to the last real safe point (the opening of "meals").
    const truncated = '{"name":"Cut Plan","meals":[{"name":"Break';
    expect(extractJson(truncated)).toBeNull();
  });
});

describe('repairTruncatedJson (direct)', () => {
  test('returns null when there is nothing open to close', () => {
    // Already-balanced text handed to the repair path directly (not how
    // extractJson calls it, but the function should still refuse gracefully).
    expect(repairTruncatedJson('not json at all')).toBeNull();
  });

  test('closes an array left open at the top level, up to the last safely-closed element', () => {
    // "b" ends the fragment mid-value with no trailing comma/bracket yet —
    // the same ambiguity as a truncated key, so it's conservatively dropped;
    // only "a" (closed by its comma) is kept.
    expect(repairTruncatedJson('{"tags":["a","b"')).toEqual({ tags: ['a'] });
  });

  test('keeps every array element that was actually closed by a comma or bracket', () => {
    expect(repairTruncatedJson('{"tags":["a","b"]')).toEqual({ tags: ['a', 'b'] });
  });
});
