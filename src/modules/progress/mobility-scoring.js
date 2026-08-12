// src/modules/progress/mobility-scoring.js
// Pure calculation/classification functions for the Mobility & Performance
// Assessment module. Frontend twin: 619-erp-frontend/src/lib/mobility-calculations.ts
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

// bodyRegions: [{region, score(1-5), pain, restriction}]
// mobilityTests: [{test, score(1-5), notes, pain, restriction}]
function calcMobilityScore(bodyRegions, mobilityTests) {
  const all = [...(bodyRegions || []), ...(mobilityTests || [])];
  const scores = all.map((i) => i.score).filter((s) => s != null);
  if (!scores.length) return null;

  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  let score = (mean / 5) * 100;

  const painCount = all.filter((i) => i.pain === true).length;
  const restrictionCount = all.filter((i) => i.restriction === true).length;
  score -= painCount * 5;
  score -= restrictionCount * 3;

  return clamp(round(score), 0, 100);
}

// Same 5-tier label set used app-wide for BP/cardio/endurance/flexibility/
// strength (fitness-scoring.js's CATEGORY_SCORES: Excellent 95, Good 80,
// Average 60, Below Average 40, Poor 20) — thresholds set at the midpoints
// between those anchors for a consistent reverse mapping.
function classifyMobility(score) {
  if (score == null) return null;
  if (score >= 88) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Average';
  if (score >= 30) return 'Below Average';
  return 'Poor';
}

module.exports = {
  calcMobilityScore,
  classifyMobility,
};
