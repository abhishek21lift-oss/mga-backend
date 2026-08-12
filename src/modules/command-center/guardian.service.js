// src/modules/command-center/guardian.service.js
//
// The AI Guardian: correlations across cards, with a confidence you can check.
//
// ── Why the rules engine is deterministic and the LLM is not in it ──────────
//
// The obvious build is: serialise the snapshot, hand it to a model, ask "what
// is wrong". It demos beautifully and it is the wrong shape for an ops console,
// for one reason — a model handed a page of metrics will always produce a
// plausible diagnosis, including when nothing is wrong and including when the
// real cause is not in the data. There is no signal in the output that
// separates "I found the problem" from "I wrote something that reads like
// finding the problem", and an operator acting on the second at 3am is worse
// off than one with no guidance at all.
//
// So the diagnosis is decided here, by rules that can be read, argued with and
// tested. The model's only job is to reword a finding this file already made.
// It cannot create a finding, change a severity, or move a confidence number.
//
// ── Confidence is computed, not asserted ────────────────────────────────────
//
// A model asked "how confident are you?" emits a number with nothing behind it.
// Here confidence is a summary of a list the UI also shows: which signals fired,
// which did not, and which COULD NOT BE CHECKED. If the number looks wrong, the
// evidence is right there to disagree with — which is the property that makes a
// confidence figure worth printing at all.
//
// It is capped below 1.0. A rules engine that claims certainty about a system
// it observes through eight sampled probes is lying, and the cap is the honest
// way to say the map is not the territory.
'use strict';

const logger = require('../../lib/logger');
const snapshot = require('./snapshot.service');
const { RULES } = require('./guardian.rules');

/** Never claim certainty; never claim less than this once triggers all fired. */
const MAX_CONFIDENCE = 0.95;
const BASE_CONFIDENCE = 0.5;
/** Each corroborating signal we could not evaluate costs this much. */
const UNKNOWN_PENALTY = 0.12;

/**
 * Evaluate one signal against the cards.
 * @returns {true|false|null} null means "could not be checked".
 */
function runSignal(signal, cards) {
  try {
    const out = signal.test(cards);
    return out === null || out === undefined ? null : Boolean(out);
  } catch (err) {
    // A rule that throws is a bug in the rule, not an incident. Treat it as
    // unknown so one bad rule cannot suppress or fabricate a finding.
    logger.warn({ err: err.message, signal: signal.key }, 'guardian signal threw');
    return null;
  }
}

function describeSafely(signal, cards) {
  try { return signal.describe ? signal.describe(cards) : signal.key; }
  catch { return signal.key; }
}

/**
 * Apply one rule.
 *
 * @returns a finding, or null when the rule does not apply.
 */
function applyRule(rule, cards) {
  const triggers = rule.triggers.map((s) => ({
    key: s.key,
    fired: runSignal(s, cards),
    detail: null,
  }));

  // ALL triggers must have fired. An unknown trigger is NOT a pass: if we
  // cannot see whether jobs are waiting, we do not get to conclude the worker
  // is starving. This is where a naive engine invents findings on a box whose
  // probes are simply not wired up.
  if (!triggers.every((t) => t.fired === true)) return null;

  for (const t of triggers) {
    const src = rule.triggers.find((s) => s.key === t.key);
    t.detail = describeSafely(src, cards);
  }

  const corroborating = (rule.corroborating ?? []).map((s) => {
    const fired = runSignal(s, cards);
    return {
      key: s.key,
      weight: s.weight ?? 1,
      fired,
      detail: fired === true ? describeSafely(s, cards) : describeSafely(s, cards),
    };
  });

  const totalWeight = corroborating.reduce((a, s) => a + s.weight, 0);
  const firedWeight = corroborating.filter((s) => s.fired === true).reduce((a, s) => a + s.weight, 0);
  const unknownCount = corroborating.filter((s) => s.fired === null).length;

  let confidence = BASE_CONFIDENCE;
  if (totalWeight > 0) confidence += (1 - BASE_CONFIDENCE) * (firedWeight / totalWeight);
  confidence -= unknownCount * UNKNOWN_PENALTY;
  confidence = Math.max(0.2, Math.min(MAX_CONFIDENCE, confidence));

  return {
    id: rule.id,
    title: rule.title,
    severity: rule.severity,
    conclusion: rule.conclusion,
    confidence: Math.round(confidence * 100) / 100,
    // The list the number summarises. Shown in the UI so the confidence is
    // checkable rather than decorative.
    evidence: {
      triggers: triggers.map((t) => ({ key: t.key, detail: t.detail })),
      supporting: corroborating.filter((s) => s.fired === true).map((s) => ({ key: s.key, detail: s.detail })),
      absent: corroborating.filter((s) => s.fired === false).map((s) => ({ key: s.key, detail: s.detail })),
      // Named separately from `absent` on purpose: "we checked and it is not
      // true" and "we could not check" are different, and collapsing them is
      // how a console starts overstating what it knows.
      unchecked: corroborating.filter((s) => s.fired === null).map((s) => ({ key: s.key, detail: s.detail })),
    },
    /** Phase 5 command names. Advisory — the Guardian never runs anything. */
    recommend: rule.recommend ?? [],
    advice: rule.advice ?? null,
    /** True when One Click Recovery applies to this finding. */
    recovery: Boolean(rule.recovery),
    sources: [...new Set([
      ...rule.triggers.map((s) => s.key),
      ...(rule.corroborating ?? []).map((s) => s.key),
    ])],
  };
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/**
 * Run every rule over a snapshot.
 *
 * Never throws — it is called from an HTTP handler that must answer during an
 * incident, and from the console's poll.
 */
async function analyse({ fresh = false } = {}) {
  let snap;
  try {
    snap = await snapshot.collect({ fresh });
  } catch (err) {
    logger.error({ err: err.message }, 'guardian could not collect a snapshot');
    return { findings: [], checked_at: new Date().toISOString(), rules_evaluated: 0, note: err.message };
  }

  const findings = [];
  for (const rule of RULES) {
    try {
      const f = applyRule(rule, snap.cards);
      if (f) findings.push(f);
    } catch (err) {
      logger.warn({ err: err.message, rule: rule.id }, 'guardian rule failed');
    }
  }

  findings.sort((a, b) => {
    const s = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    return s !== 0 ? s : b.confidence - a.confidence;
  });

  return {
    findings,
    checked_at: new Date().toISOString(),
    rules_evaluated: RULES.length,
    // Stated explicitly rather than left as an empty array to interpret. "The
    // rules ran and found nothing" is a different claim from "the Guardian did
    // not run", and an operator deserves to be told which.
    note: findings.length ? null : 'All correlation rules ran; none matched.',
  };
}

// ── Narration ───────────────────────────────────────────────────────────────

/**
 * Ask the model to reword ONE finding for a human.
 *
 * What it is given is the finding — title, conclusion, and the evidence lines
 * this file already computed. It never sees the raw snapshot, so it cannot
 * invent a metric, and it is told not to introduce a cause, because the whole
 * point of the deterministic engine is that the diagnosis is not the model's to
 * make.
 *
 * On-demand only. Narrating on every poll would spend money on every tick to
 * restate text that is already on screen.
 *
 * Never throws: a finding with no narration is the normal product. The
 * deterministic text is what the operator acts on; this is a garnish, and a
 * garnish must not be able to break the plate.
 */
async function explain(findingId, { fresh = false } = {}) {
  const { findings } = await analyse({ fresh });
  const finding = findings.find((f) => f.id === findingId);
  if (!finding) {
    const err = new Error('That finding is not currently active');
    err.status = 404;
    throw err;
  }

  const evidence = [
    ...finding.evidence.triggers.map((e) => `- ${e.detail}`),
    ...finding.evidence.supporting.map((e) => `- ${e.detail}`),
  ].join('\n');

  const prompt = [
    'You are writing for a platform operator looking at a live incident console.',
    '',
    `DIAGNOSIS (already determined — do not change it, do not propose a different cause): ${finding.title}`,
    `REASONING: ${finding.conclusion}`,
    'EVIDENCE:',
    evidence,
    finding.advice ? `KNOWN CONSTRAINT: ${finding.advice}` : '',
    '',
    'Write at most three sentences telling the operator what to do first and what not to waste',
    'time on. Use only the evidence above. Do not invent numbers, do not speculate about causes',
    'that are not listed, and do not restate the diagnosis verbatim.',
  ].filter(Boolean).join('\n');

  try {
    const { routedChat } = require('../../lib/ai/router');
    const res = await routedChat({
      intent: 'chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 220,
      temperature: 0.2,
    });
    const text = typeof res?.content === 'string' ? res.content.trim() : null;
    if (!text) return { finding_id: findingId, narration: null, unavailable_reason: 'The model returned nothing.' };

    return {
      finding_id: findingId,
      narration: text,
      model: res?.model ?? null,
      used_fallback: res?.used_fallback ?? null,
      // Surfaced so the UI can label it. An operator must always be able to
      // tell which sentence a machine wrote and which came from a rule.
      generated: true,
    };
  } catch (err) {
    logger.warn({ err: err.message, finding: findingId }, 'guardian narration failed');
    return {
      finding_id: findingId,
      narration: null,
      unavailable_reason: `AI narration is unavailable: ${err.message}`,
    };
  }
}

module.exports = {
  analyse, explain, applyRule,
  MAX_CONFIDENCE, BASE_CONFIDENCE, UNKNOWN_PENALTY, RULES,
};
