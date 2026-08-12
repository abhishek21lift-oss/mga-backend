// src/modules/progress/posture-scoring.js
// Pure calculation/classification functions for the Posture Assessment
// module. Frontend twin: 619-erp-frontend/src/lib/posture-calculations.ts
// (same formulas, duplicated deliberately since there's no shared package
// between the two apps). Scores are always computed here (server-side),
// never trusted from client-submitted values.

function round(n, decimals = 0) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Scoliosis is weighted higher — it's the one deviation on this list that's
// a genuine referral flag rather than just a coaching cue.
const ISSUE_WEIGHT = { Scoliosis: 15 };
const DEFAULT_ISSUE_WEIGHT = 8;

function calcPostureRiskScore(frontIssues, sideIssues, backIssues) {
  const distinct = new Set([...(frontIssues || []), ...(sideIssues || []), ...(backIssues || [])]);
  let deduction = 0;
  for (const issue of distinct) {
    deduction += ISSUE_WEIGHT[issue] ?? DEFAULT_ISSUE_WEIGHT;
  }
  return clamp(round(100 - deduction), 0, 100);
}

// Same Low/Moderate/High thresholds used identically in Lifestyle/Nutrition
// scoring (score>=70 Low, score>=40 Moderate, else High).
function classifyRisk(score) {
  if (score == null) return null;
  return score >= 70 ? 'Low' : score >= 40 ? 'Moderate' : 'High';
}

module.exports = {
  calcPostureRiskScore,
  classifyRisk,
};
