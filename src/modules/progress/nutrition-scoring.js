// src/modules/progress/nutrition-scoring.js
// Pure calculation/classification functions for the Nutrition Assessment
// module. Frontend twin: 619-erp-frontend/src/lib/nutrition-calculations.ts
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

// ── Step 6: Diet Quality ──
const JUNK_ITEMS = ['Sugar', 'Soft Drinks', 'Fried Food', 'Fast Food', 'Bakery', 'Processed Food'];
const WHOLE_FOOD_FAVOURITES = ['Fruits', 'Dal', 'Curd', 'Oats', 'Dry Fruits', 'Peanut Butter'];
const NEGATIVE_BEHAVIOURS = ['Emotional Eating', 'Stress Eating', 'Night Eating', 'Binge Eating', 'Skipped Meals'];
const POSITIVE_BEHAVIOURS = ['Mindful Eater', 'Slow Eater'];

function calcDietQualityScore(foodsToAvoid, favouriteFoods, cravings, cravingFrequency, eatingBehaviours, breakfastRegularity, lateNightEating) {
  let score = 60;
  const avoidedJunk = (foodsToAvoid || []).filter((f) => JUNK_ITEMS.includes(f)).length;
  score += Math.min(20, avoidedJunk * 4);
  const wholeFav = (favouriteFoods || []).filter((f) => WHOLE_FOOD_FAVOURITES.includes(f)).length;
  score += Math.min(15, wholeFav * 3);
  const negCount = (eatingBehaviours || []).filter((b) => NEGATIVE_BEHAVIOURS.includes(b)).length;
  score -= Math.min(20, negCount * 5);
  const posCount = (eatingBehaviours || []).filter((b) => POSITIVE_BEHAVIOURS.includes(b)).length;
  score += Math.min(10, posCount * 5);
  if (cravingFrequency === 'daily') score -= 15;
  else if (cravingFrequency === 'sometimes') score -= 5;
  if ((cravings || []).includes('No Cravings')) score += 5;
  if (breakfastRegularity === 'daily') score += 5;
  else if (breakfastRegularity === 'never') score -= 5;
  if (lateNightEating === true) score -= 10;
  return clamp(round(score), 0, 100);
}

// ── Step 3/4: Protein — a stated-preference proxy, not measured intake. ──
const PROTEIN_RICH_FAVOURITES = ['Chicken', 'Eggs', 'Paneer', 'Fish', 'Dal', 'Curd', 'Peanut Butter'];
const PROTEIN_SUPPLEMENTS = ['Whey Protein', 'EAA', 'BCAA'];
function assessProtein(favouriteFoods, takesSupplements, supplements) {
  let points = (favouriteFoods || []).filter((f) => PROTEIN_RICH_FAVOURITES.includes(f)).length;
  if (takesSupplements && (supplements || []).some((s) => PROTEIN_SUPPLEMENTS.includes(s.name))) points += 3;
  if (points >= 6) return { assessment: 'High', score: 90 };
  if (points >= 3) return { assessment: 'Adequate', score: 70 };
  if (points >= 1) return { assessment: 'Low', score: 40 };
  return { assessment: 'Very Low', score: 20 };
}

// ── Step 7: Hydration ── documented approximate cup→liter conversions.
function calcDailyFluidIntake(waterLiters, teaCups, coffeeCups, softDrinks, juices) {
  if (waterLiters == null && !teaCups && !coffeeCups && !softDrinks && !juices) return null;
  const w = waterLiters ?? 0, t = teaCups ?? 0, c = coffeeCups ?? 0, s = softDrinks ?? 0, j = juices ?? 0;
  return round(w + t * 0.15 + c * 0.15 + s * 0.25 + j * 0.2, 1);
}

function calcHydrationScore(waterLiters, softDrinksPerDay, alcoholicDrinksPerWeek) {
  if (waterLiters == null) return null;
  let score = waterLiters < 1.5 ? 25 : waterLiters < 2.5 ? 55 : waterLiters < 3.5 ? 85 : 100;
  if (softDrinksPerDay != null && softDrinksPerDay >= 2) score -= 10;
  if (alcoholicDrinksPerWeek != null && alcoholicDrinksPerWeek >= 7) score -= 10;
  return clamp(score, 0, 100);
}

// ── Step 5: Digestive Health ── digestiveIssues: [{issue, frequency, severity}]
const FREQ_WEIGHT = { daily: 3, weekly: 1.5, rare: 0.5 };
function calcDigestiveHealthScore(digestiveIssues) {
  if (!digestiveIssues || digestiveIssues.length === 0) return 100;
  let deduction = 0;
  for (const issue of digestiveIssues) {
    const w = FREQ_WEIGHT[issue.frequency] ?? 1;
    deduction += (issue.severity || 0) * w;
  }
  return clamp(round(100 - deduction), 0, 100);
}

// ── Step 4: Supplement Usage ──
const FOUNDATIONAL_SUPPLEMENTS = ['Whey Protein', 'Omega 3', 'Vitamin D', 'Multivitamin'];
function calcSupplementScore(takesSupplements, supplements) {
  if (!takesSupplements) return 50;
  const covered = FOUNDATIONAL_SUPPLEMENTS.filter((f) => (supplements || []).some((s) => s.name === f)).length;
  return clamp(40 + covered * 15, 40, 100);
}

// ── Nutrition risk score + matching badges — same trigger thresholds, kept
// side by side. smokingStatus/alcoholStatus come from a cross-module lookup
// of the client's latest Lifestyle Assessment (may be null if none exists). ──
function calcNutritionRiskScore({ proteinAssessment, hydrationScore, digestiveHealthScore, cravings, cravingFrequency, medicalConditions, medicalNotes, alcoholStatus, smokingStatus }) {
  let risk = 0;
  if (proteinAssessment === 'Low' || proteinAssessment === 'Very Low') risk += 15;
  if (hydrationScore != null && hydrationScore < 55) risk += 10;
  if (digestiveHealthScore != null && digestiveHealthScore < 50) risk += 15;

  const dailyCraving = cravingFrequency === 'daily';
  if (dailyCraving && (cravings || []).includes('Sweet')) risk += 10;
  if (dailyCraving && (cravings || []).includes('Fast Food')) risk += 10;

  const hasUnmanagedMedical = (medicalConditions || []).some((c) => c !== 'None') && !medicalNotes;
  if (hasUnmanagedMedical) risk += 10;

  if (alcoholStatus === 'weekly' || alcoholStatus === 'frequently') risk += 15;
  if (smokingStatus === 'daily' || smokingStatus === 'occasionally') risk += 15;

  return clamp(risk, 0, 100);
}

function buildNutritionRiskFactors({ proteinAssessment, hydrationScore, digestiveHealthScore, cravings, cravingFrequency, alcoholStatus, smokingStatus }) {
  const factors = [];
  if (proteinAssessment === 'Low' || proteinAssessment === 'Very Low') factors.push('Low Protein Intake');
  if (hydrationScore != null && hydrationScore < 55) factors.push('Poor Hydration');
  if (digestiveHealthScore != null && digestiveHealthScore < 50) factors.push('Frequent Digestive Issues');

  const dailyCraving = cravingFrequency === 'daily';
  if (dailyCraving && (cravings || []).includes('Fast Food')) factors.push('Excess Processed Food');
  if (dailyCraving && (cravings || []).includes('Sweet')) factors.push('Excess Sugar Intake');
  if (proteinAssessment === 'Very Low') factors.push('Nutrient Deficiency Risk');

  if (alcoholStatus === 'weekly' || alcoholStatus === 'frequently') factors.push('Alcohol Risk');
  if (smokingStatus === 'daily' || smokingStatus === 'occasionally') factors.push('Smoking Impact on Nutrition');

  return factors;
}

// ── Overall composite ──
function calcNutritionScore(fiveScores, riskScore) {
  const vals = Object.values(fiveScores).filter((v) => v != null);
  if (!vals.length) return null;
  const base = vals.reduce((a, b) => a + b, 0) / vals.length;
  const penalty = (riskScore || 0) * 0.2;
  return clamp(round(base - penalty), 0, 100);
}

function classifyNutritionReadiness(nutritionScore) {
  if (nutritionScore == null) return null;
  if (nutritionScore >= 85) return 'Excellent';
  if (nutritionScore >= 70) return 'Good';
  if (nutritionScore >= 50) return 'Average';
  if (nutritionScore >= 30) return 'Needs Improvement';
  return 'High Risk';
}

module.exports = {
  calcDietQualityScore,
  assessProtein,
  calcDailyFluidIntake,
  calcHydrationScore,
  calcDigestiveHealthScore,
  calcSupplementScore,
  calcNutritionRiskScore,
  buildNutritionRiskFactors,
  calcNutritionScore,
  classifyNutritionReadiness,
};
