// src/modules/progress/goal-scoring.js
// Pure calculation/classification functions for the Goal Assessment
// module. Frontend twin: 619-erp-frontend/src/lib/goal-calculations.ts
// (same formulas, duplicated deliberately since there's no shared package
// between the two apps). Scores/analysis are always computed here
// (server-side), never trusted from client-submitted values.

function round(n, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ── Lifestyle Readiness ─────────────────────────────────────
// 6 yes/no questions. medical_restrictions is inverted: "No restrictions"
// is the favorable answer.
function calcLifestyleReadinessScore(answers) {
  if (!answers || typeof answers !== 'object') return null;
  const keys = ['can_train_4_6_days', 'meal_prep_possible', 'sleep_7_8_hours', 'drink_enough_water', 'family_support', 'medical_restrictions'];
  let favorable = 0;
  let answered = 0;
  for (const key of keys) {
    const v = answers[key];
    if (typeof v !== 'boolean') continue;
    answered++;
    const isFavorable = key === 'medical_restrictions' ? v === false : v === true;
    if (isFavorable) favorable++;
  }
  if (answered === 0) return null;
  return Math.round((favorable / keys.length) * 100);
}

// ── Weight-change rate ──────────────────────────────────────
function goalDirection(startingWeight, targetWeight) {
  if (startingWeight == null || targetWeight == null) return null;
  if (targetWeight < startingWeight) return 'loss';
  if (targetWeight > startingWeight) return 'gain';
  return 'maintain';
}

// Signed kg/week required to hit the target by the deadline.
function calcRequiredWeeklyRate(startingWeight, targetWeight, daysRemaining) {
  if (startingWeight == null || targetWeight == null || daysRemaining == null || daysRemaining <= 0) return null;
  const weeksRemaining = daysRemaining / 7;
  if (weeksRemaining <= 0) return null;
  return round((targetWeight - startingWeight) / weeksRemaining);
}

// Conservative, general Phase-1 benchmarks — not clinical guidance.
// Fat loss: 0.75% of starting bodyweight/week. Muscle gain: ~0.35 kg/month.
function calcSafeWeeklyRate(startingWeight, direction) {
  if (direction === 'loss') {
    if (startingWeight == null) return null;
    return round(startingWeight * 0.0075);
  }
  if (direction === 'gain') {
    return round(0.35 / 4.33);
  }
  return null;
}

// ── Difficulty ───────────────────────────────────────────────
const DIFFICULTY_LEVELS = ['Easy', 'Moderate', 'Hard', 'Very Hard'];
function classifyGoalDifficulty(requiredRate, safeRate, lifestyleReadinessScore, motivationLevel, commitmentLevel) {
  if (requiredRate == null || safeRate == null || safeRate === 0) return null;
  const ratio = Math.abs(requiredRate) / safeRate;
  let level = ratio <= 0.6 ? 0 : ratio <= 1.0 ? 1 : ratio <= 1.5 ? 2 : 3;

  const lowSignal = (lifestyleReadinessScore != null && lifestyleReadinessScore < 40)
    || (motivationLevel != null && motivationLevel <= 3)
    || (commitmentLevel != null && commitmentLevel <= 3);
  const highSignal = (lifestyleReadinessScore != null && lifestyleReadinessScore >= 80)
    && (motivationLevel != null && motivationLevel >= 8)
    && (commitmentLevel != null && commitmentLevel >= 8);

  if (lowSignal) level += 1;
  else if (highSignal) level -= 1;

  level = Math.max(0, Math.min(DIFFICULTY_LEVELS.length - 1, level));
  return DIFFICULTY_LEVELS[level];
}

// ── Duration ─────────────────────────────────────────────────
// Realistic duration at the SAFE rate — independent of the user's chosen
// deadline. Powers the "unrealistic timeline" smart alert.
function calcEstimatedDurationWeeks(startingWeight, targetWeight, safeWeeklyRate) {
  if (startingWeight == null || targetWeight == null || !safeWeeklyRate) return null;
  const weeks = Math.abs(targetWeight - startingWeight) / safeWeeklyRate;
  return Math.max(1, Math.ceil(weeks));
}

function recommendPtDurationMonths(estimatedWeeks) {
  if (estimatedWeeks == null) return null;
  if (estimatedWeeks <= 4) return 1;
  if (estimatedWeeks <= 13) return 3;
  if (estimatedWeeks <= 26) return 6;
  return 12;
}

// ── Risk factors ─────────────────────────────────────────────
function buildRiskFactors({ requiredRate, safeRate, lifestyleReadinessScore, medicalRestrictions, daysRemaining, motivationLevel, commitmentLevel }) {
  const risks = [];
  const ratio = requiredRate != null && safeRate ? Math.abs(requiredRate) / safeRate : null;

  if (ratio != null && ratio > 1.5) {
    risks.push('Required weekly rate of change exceeds safe guidelines for this timeline.');
  }
  if (lifestyleReadinessScore != null && lifestyleReadinessScore < 40) {
    risks.push('Low lifestyle readiness — schedule, sleep, or support may limit consistency.');
  }
  if (medicalRestrictions === true) {
    risks.push('Medical restrictions flagged — recommend physician clearance before starting.');
  }
  if (daysRemaining != null && daysRemaining < 14 && ratio != null && ratio > 1) {
    risks.push('Very short timeline for the required change.');
  }
  if (motivationLevel != null && motivationLevel <= 3) {
    risks.push('Low motivation score — consider addressing mindset before an aggressive plan.');
  }
  if (commitmentLevel != null && commitmentLevel <= 3) {
    risks.push('Low commitment score — a lighter, more sustainable plan may fit better.');
  }
  return risks;
}

module.exports = {
  calcLifestyleReadinessScore,
  goalDirection,
  calcRequiredWeeklyRate,
  calcSafeWeeklyRate,
  classifyGoalDifficulty,
  calcEstimatedDurationWeeks,
  recommendPtDurationMonths,
  buildRiskFactors,
};
