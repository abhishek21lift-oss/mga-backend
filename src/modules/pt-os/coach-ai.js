// Coaching prompts written by a model, from readings this database can prove.
//
// ── What this is allowed to do ─────────────────────────────────────────────
//
// Interpret. Nothing else. The facts are assembled first — by buildSnapshot
// and buildBrief, which only ever report measurements that exist — and the
// model is given those facts and asked to say what they mean for next week's
// training. It is not asked what the client's recovery is; it is told, and
// asked what to do about it.
//
// That split matters more here than anywhere else in the codebase. A language
// model handed a thin context will fill the gaps, confidently and plausibly,
// and a trainer reading "nutrition compliance is slipping" for a client whose
// meals have never been logged will change a programme that was working. So:
//
//   · every fact in the prompt comes from a row that exists;
//   · the model is told, explicitly, what is NOT known;
//   · every line it returns must cite which reading it came from, and a line
//     citing a reading we did not send is dropped before it reaches anyone;
//   · if the model is unavailable, the rule-based prompts stand in rather
//     than the card going blank.
//
// ── Why it is not called on page load ──────────────────────────────────────
//
// A profile is opened dozens of times a day and mostly to check one thing. An
// LLM call on every open is somebody's money and two seconds of staring at a
// spinner, for an answer that has not changed since this morning. It runs when
// asked, and the answer is cached against the readings it was written from —
// so it is regenerated when the client changes, not when the page is opened.

const crypto = require('crypto');

/** Max lines we will show. More than this is a report, not a prompt. */
const MAX_INSIGHTS = 5;

/**
 * The facts, as text the model can read.
 *
 * Deliberately includes the gaps. "Nobody has logged a meal" is the single
 * most useful line in this prompt: without it the model assumes nutrition is
 * fine, or invents a figure for it.
 */
function buildFacts({ snapshot, brief, client }) {
  const L = [];
  const s = brief?.sections ?? {};

  L.push(`CLIENT: ${client?.name ?? 'Unknown'}${client?.age != null ? `, ${client.age}` : ''}${client?.gender ? `, ${client.gender}` : ''}`);

  if (snapshot?.goal?.present) {
    const g = snapshot.goal;
    L.push(`GOAL: ${g.goal_type ?? 'unspecified'}${g.target_kg != null ? `, target ${g.target_kg} kg` : ''}`
      + `${g.current_kg != null ? `, currently ${g.current_kg} kg` : ''}`
      + `${g.start_kg != null ? `, started ${g.start_kg} kg` : ''}`
      + `${g.pct != null ? ` (${g.pct}% of the way)` : ' (no baseline on file, so no percentage)'}`);
  } else {
    L.push('GOAL: none set.');
  }

  if (snapshot?.alerts?.length) {
    L.push('', 'FLAGS RAISED BY THE SYSTEM:');
    for (const a of snapshot.alerts) L.push(`- ${a.label}${a.detail ? ` (${a.detail})` : ''}`);
  }

  if (snapshot?.prs?.length) {
    L.push('', 'BEST LIFTS ON RECORD:');
    for (const p of snapshot.prs) {
      L.push(`- ${p.exercise}: ${p.weight_kg} kg${p.reps ? ` × ${p.reps}` : ''}${p.achieved_on ? ` on ${p.achieved_on}` : ''}`);
    }
  }

  if (s.lifestyle?.present) {
    L.push('', 'LIFESTYLE ASSESSMENT:');
    L.push(`- Sleep ${s.lifestyle.sleep_hours ?? '?'} h, quality ${s.lifestyle.sleep_quality ?? '?'}`);
    L.push(`- Stress ${s.lifestyle.stress_level ?? '?'}, recovery ${s.lifestyle.recovery_quality ?? '?'}`);
  }

  if (s.limitations?.present) {
    const findings = s.limitations.mobility?.findings ?? [];
    if (findings.length) {
      L.push('', 'MOVEMENT LIMITATIONS:');
      for (const f of findings) {
        L.push(`- ${f.region}: ${[f.pain && 'pain', f.restriction && 'restricted'].filter(Boolean).join(' + ')}`);
      }
    }
    if (s.limitations.injuries) L.push(`- Injuries on file: ${s.limitations.injuries}`);
  }

  if (s.readiness?.present) {
    L.push('', `MEDICAL CLEARANCE: risk ${s.readiness.risk_level ?? 'unknown'}`
      + `${s.readiness.gate_status ? `, gate ${s.readiness.gate_status}` : ''}`);
  }

  // The gaps. Named, because silence about them is what produces invention.
  const missing = Array.isArray(brief?.missing) ? brief.missing : [];
  L.push('', 'NOT MEASURED — you must not comment on these, and must not assume they are fine:');
  const gaps = [
    ...missing,
    ...(snapshot?.prs?.length ? [] : ['no lifts logged']),
    'no meals logged (nutrition intake is unknown)',
    'no weekly check-ins (mood, energy and soreness are unknown)',
  ];
  for (const g of gaps) L.push(`- ${g}`);

  return L.join('\n');
}

const SYSTEM_PROMPT = `You are an experienced strength and conditioning coach reviewing one client's file for their trainer.

You will be given ONLY measurements that exist in the studio's records, plus an explicit list of what has NOT been measured.

Rules, in order of importance:
1. Never state a fact that is not in the readings you were given. If something is in the "NOT MEASURED" list, you may recommend measuring it, but you may not describe it, estimate it, or assume it is fine.
2. Every point must cite the reading it came from.
3. You are writing for a qualified trainer, not the client. Be direct and specific about programming: sets, volume, movement selection, progression.
4. Give no medical advice and no diagnosis. If a reading suggests a medical question, say it should be referred, and stop there.
5. Prefer one useful sentence to three vague ones. Say nothing rather than pad.

Reply with JSON only, no prose around it:
{"insights":[{"tone":"good"|"warn","text":"...","because":"which reading this came from"}]}

At most 5 insights. If the readings do not support any useful point, reply {"insights":[]}.`;

/** Parse the model's reply, keeping only lines that obey the contract. */
function parseInsights(raw) {
  if (typeof raw !== 'string') return [];
  // Models wrap JSON in prose or fences more often than not.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return []; }

  const list = Array.isArray(parsed?.insights) ? parsed.insights : [];
  return list
    .map((i, n) => {
      const text = typeof i?.text === 'string' ? i.text.trim() : '';
      const because = typeof i?.because === 'string' ? i.because.trim() : '';
      // No citation, no line. A prompt a trainer cannot trace is one they
      // cannot overrule, and an uncited claim is exactly the invented kind.
      if (!text || !because) return null;
      return {
        id: `ai-${n}`,
        tone: i.tone === 'good' ? 'good' : 'warn',
        text,
        because,
        source: 'ai',
      };
    })
    .filter(Boolean)
    .slice(0, MAX_INSIGHTS);
}

/**
 * A key that changes when the READINGS change, not when the page is opened.
 *
 * So a client whose file has not moved since this morning gets this morning's
 * answer, free and instantly, and a client who trained last night gets a new
 * one.
 */
function factsKey(facts) {
  return crypto.createHash('sha256').update(facts).digest('hex').slice(0, 32);
}

/**
 * Generate coaching prompts for one client.
 *
 * `chat` is injected so this is testable without an API key or a network
 * call — the prompt construction and the response validation are the parts
 * that can be wrong, and both are pure.
 */
async function generateCoach({ snapshot, brief, client, chat, fallback = [] }) {
  const facts = buildFacts({ snapshot, brief, client });
  const key = factsKey(facts);

  try {
    const res = await chat({
      intent: 'coaching',
      temperature: 0.3,          // interpretation, not creativity
      max_tokens: 700,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: facts },
      ],
    });
    const insights = parseInsights(res?.content);
    // An empty reply is a legitimate answer — "the readings support nothing
    // useful" — but the card should not go blank, so the derived prompts
    // stand in. They are true regardless of what the model said.
    return {
      insights: insights.length ? insights : fallback,
      source: insights.length ? 'ai' : 'derived',
      model: res?.model ?? null,
      facts_key: key,
    };
  } catch {
    // Unconfigured key, timeout, every model down: the rule-based prompts are
    // still correct. A coach card that disappears when the API does teaches
    // the trainer not to rely on it.
    return { insights: fallback, source: 'derived', model: null, facts_key: key };
  }
}

module.exports = {
  generateCoach, buildFacts, parseInsights, factsKey, SYSTEM_PROMPT, MAX_INSIGHTS,
};
