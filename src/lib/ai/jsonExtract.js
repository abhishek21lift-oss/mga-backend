'use strict';
// Pulls a JSON object out of a model's raw text completion. Every
// structured-output AI route (workout, diet, progress, fitness-testing,
// business insights) funnels its response through this.

/**
 * Strips markdown code fences (models add them despite "no code fences"
 * often enough that a raw parse fails), then finds and parses the first
 * balanced { ... } object in the text. If the model was cut off mid-object
 * (hit max_tokens before finishing), falls back to repairTruncatedJson to
 * salvage whatever part of the structure DID complete.
 */
function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  // Balanced-brace scan: parse from the first '{' to its matching close.
  // A greedy /\{[\s\S]+\}/ regex spans first-{ to LAST-}, which breaks
  // whenever prose or a second object follows the JSON.
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  // The scan reached end-of-text with braces still open — the model hit
  // max_tokens mid-object rather than finishing normally. This is the diet
  // schema's most common failure: meals[].foods[] + grocery_list +
  // supplements is far more token-hungry than the workout schema's, so a
  // long plan gets cut off before its closing brace and a plain parse would
  // throw the plan away entirely. Try to salvage what was actually
  // completed instead of discarding it.
  return repairTruncatedJson(cleaned.slice(start));
}

/**
 * Closes a JSON object/array that was cut off mid-stream (hit max_tokens
 * before finishing) so the part that DID complete can still be parsed and
 * used, rather than failing the whole generation over a few trailing bytes.
 *
 * Walks the fragment tracking open '{'/'[' on a stack and the last position
 * it's safe to truncate at. Only a comma or a closing bracket/brace OUTSIDE
 * a string counts as safe — never right after a bare string, because that
 * string could be a KEY whose value never arrived ({"a":"hello","b" — the
 * closing quote after "b" looks final but isn't). Being conservative here
 * means occasionally dropping one trailing field that actually completed,
 * which is a fine trade for never producing invalid JSON.
 *
 * Cuts at the last safe point, drops a dangling trailing comma (invalid
 * immediately before a closing brace), then appends closers for whatever
 * was left open, in reverse order. Returns null if nothing was salvageable.
 */
function repairTruncatedJson(fragment) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1;
  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') { stack.pop(); lastSafe = i; continue; }
    if (ch === ',') lastSafe = i;
  }
  if (stack.length === 0 || lastSafe === -1) return null;

  const repaired = fragment.slice(0, lastSafe + 1).replace(/,\s*$/, '')
    + stack.reverse().map(open => (open === '{' ? '}' : ']')).join('');
  try { return JSON.parse(repaired); } catch { return null; }
}

module.exports = { extractJson, repairTruncatedJson };
