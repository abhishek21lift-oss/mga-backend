// src/modules/progress/lifestyle-scoring.js
// Pure calculation/classification functions for the Lifestyle Assessment
// module. Frontend twin: 619-erp-frontend/src/lib/lifestyle-calculations.ts
// (same formulas, duplicated deliberately since there's no shared package
// between the two apps). Scores/analysis are always computed here
// (server-side), never trusted from client-submitted values.

function round(n, decimals = 0) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function mean(vals) {
  const filtered = vals.filter((v) => v != null);
  if (!filtered.length) return null;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

// ── Step 1: Sleep ── duration scored against a 7-9h ideal range (same
// ideal-range-with-falloff shape as fitness-scoring.js's body-fat scorer),
// averaged with self-reported quality.
function classifySleep(durationHours, quality) {
  const durationScore = durationHours == null ? null
    : durationHours >= 7 && durationHours <= 9 ? 100
    : clamp(100 - (durationHours < 7 ? 7 - durationHours : durationHours - 9) * 20, 0, 100);
  const qualityScore = quality == null ? null : quality * 10;
  const score = mean([durationScore, qualityScore]);
  if (score == null) return { category: null, score: null };
  const category = score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Poor';
  return { category, score: round(score) };
}

// ── Step 2: Stress ──
function calcStressScore(stressLevel) {
  if (stressLevel == null) return null;
  return clamp((11 - stressLevel) * 10, 0, 100);
}

// ── Step 3: Water ──
function classifyHydration(liters) {
  if (liters == null) return { category: null, score: null };
  if (liters < 1.5) return { category: 'Low', score: 25 };
  if (liters < 2.5) return { category: 'Moderate', score: 55 };
  if (liters < 3.5) return { category: 'Optimal', score: 85 };
  return { category: 'Excellent', score: 100 };
}

// ── Step 4: Occupation & Activity ── steps bracket drives the activity
// level 1:1; occupation only nudges the numeric score.
const ACTIVITY_BASE = { '<3000': 20, '3000_5000': 40, '5000_8000': 60, '8000_10000': 80, '10000_plus': 100 };
const ACTIVITY_LEVEL = { '<3000': 'Sedentary', '3000_5000': 'Lightly Active', '5000_8000': 'Moderately Active', '8000_10000': 'Active', '10000_plus': 'Very Active' };
const ACTIVE_OCCUPATIONS = ['physical_labor', 'active_job', 'fitness_professional', 'police'];
const SEDENTARY_OCCUPATIONS = ['desk_job', 'driver', 'student', 'retired'];
function classifyActivity(stepsBracket, occupationType) {
  if (!stepsBracket || ACTIVITY_BASE[stepsBracket] == null) return { level: null, score: null };
  let score = ACTIVITY_BASE[stepsBracket];
  if (ACTIVE_OCCUPATIONS.includes(occupationType)) score += 10;
  else if (SEDENTARY_OCCUPATIONS.includes(occupationType)) score -= 10;
  return { level: ACTIVITY_LEVEL[stepsBracket], score: clamp(score, 0, 100) };
}

// ── Step 7: Meal Frequency / Nutrition ──
function calcNutritionScore(mealFrequency, breakfastHabit, lateNightEating) {
  if (mealFrequency == null && breakfastHabit == null && lateNightEating == null) return null;
  let score = 100;
  if (mealFrequency != null) {
    if (mealFrequency === 2 || mealFrequency === 5) score -= 10;
    else if (mealFrequency >= 6) score -= 20;
  }
  if (breakfastHabit === 'sometimes') score -= 15;
  else if (breakfastHabit === 'never') score -= 30;
  if (lateNightEating === true) score -= 15;
  return clamp(round(score), 0, 100);
}

// ── Step 9: Recovery ──
const RECOVERY_QUALITY_SCORE = { poor: 20, average: 50, good: 75, excellent: 100 };
function calcRecoveryScore(sleepScore, stressScore, energyLevel, recoveryQuality) {
  const energyScore = energyLevel == null ? null : energyLevel * 10;
  const qualityScore = recoveryQuality ? RECOVERY_QUALITY_SCORE[recoveryQuality] ?? null : null;
  const score = mean([sleepScore, stressScore, energyScore, qualityScore]);
  return score == null ? null : round(score);
}

// ── Risk classification (shared by sedentary + recovery risk) ──
function classifyRisk(score) {
  if (score == null) return null;
  return score >= 70 ? 'Low' : score >= 40 ? 'Moderate' : 'High';
}

// ── Habit risk score + matching badges — same trigger thresholds, kept
// side by side so a change to one is obviously a change to the other. ──
function calcHabitRiskScore({ smokingStatus, alcoholStatus, sleepScore, stressScore, hydrationScore, activityScore, nutritionScore }) {
  let risk = 0;
  if (smokingStatus === 'daily') risk += 30;
  else if (smokingStatus === 'occasionally') risk += 15;
  else if (smokingStatus === 'former') risk += 5;

  if (alcoholStatus === 'frequently') risk += 20;
  else if (alcoholStatus === 'weekly') risk += 10;
  else if (alcoholStatus === 'occasionally') risk += 5;

  if (sleepScore != null && sleepScore < 40) risk += 15;
  if (stressScore != null && stressScore < 40) risk += 15;
  if (hydrationScore != null && hydrationScore < 55) risk += 10;
  if (activityScore != null && activityScore < 40) risk += 15;
  if (nutritionScore != null && nutritionScore < 50) risk += 10;

  return clamp(risk, 0, 100);
}

function buildLifestyleRiskFactors({ smokingStatus, alcoholStatus, sleepScore, stressScore, hydrationScore, activityScore, nutritionScore }) {
  const factors = [];
  if (sleepScore != null && sleepScore < 40) factors.push('Poor Sleep');
  if (stressScore != null && stressScore < 40) factors.push('High Stress');
  if (hydrationScore != null && hydrationScore < 55) factors.push('Low Water Intake');
  if (activityScore != null && activityScore < 40) factors.push('Low Activity');
  if (smokingStatus === 'daily' || smokingStatus === 'occasionally') factors.push('Smoking');
  if (alcoholStatus && alcoholStatus !== 'never') factors.push('Alcohol');
  if (nutritionScore != null && nutritionScore < 50) factors.push('Poor Meal Frequency');
  return factors;
}

// ── Overall composite ──
function calcLifestyleScore(sixScores, habitRiskScore) {
  const base = mean(Object.values(sixScores));
  if (base == null) return null;
  const penalty = (habitRiskScore || 0) * 0.2;
  return clamp(round(base - penalty), 0, 100);
}

function classifyLifestyleReadiness(lifestyleScore) {
  if (lifestyleScore == null) return null;
  if (lifestyleScore >= 85) return 'Excellent';
  if (lifestyleScore >= 70) return 'Good';
  if (lifestyleScore >= 50) return 'Average';
  if (lifestyleScore >= 30) return 'Needs Improvement';
  return 'High Risk';
}

module.exports = {
  classifySleep,
  calcStressScore,
  classifyHydration,
  classifyActivity,
  calcNutritionScore,
  calcRecoveryScore,
  classifyRisk,
  calcHabitRiskScore,
  buildLifestyleRiskFactors,
  calcLifestyleScore,
  classifyLifestyleReadiness,
};
