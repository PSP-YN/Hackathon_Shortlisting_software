import { CriterionConfig, ScoringMode, CriterionScoreResult } from '@/types';

export interface ScoreCalculationResult {
  calculatedTotal: number;
  maxPossibleScore: number;
  validatedScores: CriterionScoreResult[];
  warnings: string[];
}

/**
 * Deterministically computes the authoritative total score on the backend.
 * Gemini NEVER calculates or overrides the authoritative arithmetic.
 */
export function calculateFinalScore(
  criteria: CriterionConfig[],
  rawScores: CriterionScoreResult[],
  mode: ScoringMode,
  totalMaxScore: number = 100
): ScoreCalculationResult {
  const warnings: string[] = [];
  const validatedScores: CriterionScoreResult[] = [];

  // Map raw scores by criterionId
  const rawScoreMap = new Map<string, CriterionScoreResult>();
  for (const s of rawScores) {
    rawScoreMap.set(s.criterionId, s);
  }

  // Validate and clamp each configured criterion
  for (const crit of criteria) {
    const raw = rawScoreMap.get(crit.id);
    if (!raw) {
      warnings.push(`Missing evaluation for criterion "${crit.name}" (ID: ${crit.id}). Defaulting to 0.`);
      validatedScores.push({
        criterionId: crit.id,
        score: 0,
        maxScore: crit.maxPoints,
        justification: 'Criterion was not addressed in the evaluation output.',
        confidence: 'low',
        slideOrPageRef: 'N/A',
      });
      continue;
    }

    let clampedScore = Number(raw.score);
    if (isNaN(clampedScore) || clampedScore < 0) {
      warnings.push(`Invalid score (${raw.score}) for "${crit.name}". Clamped to 0.`);
      clampedScore = 0;
    } else if (clampedScore > crit.maxPoints) {
      warnings.push(
        `Score (${clampedScore}) exceeded max allowed (${crit.maxPoints}) for "${crit.name}". Clamped to max.`
      );
      clampedScore = crit.maxPoints;
    }

    validatedScores.push({
      criterionId: crit.id,
      score: Math.round(clampedScore * 100) / 100,
      maxScore: crit.maxPoints,
      justification: raw.justification || 'No justification provided.',
      confidence: raw.confidence || 'medium',
      slideOrPageRef: raw.slideOrPageRef || 'N/A',
    });
  }

  let calculatedTotal = 0;
  let maxPossibleScore = totalMaxScore;

  if (mode === 'direct_points') {
    // Mode A: Direct Points Sum
    let sum = 0;
    let max = 0;
    for (const s of validatedScores) {
      sum += s.score;
      max += s.maxScore;
    }
    calculatedTotal = Math.round(sum * 100) / 100;
    maxPossibleScore = max;
  } else if (mode === 'weighted') {
    // Mode B: Weighted Scoring Formula
    // Total = Sum( (score_i / max_i) * weight_i ) * totalMaxScore
    let weightedRatioSum = 0;
    let totalWeight = 0;

    for (const crit of criteria) {
      const scoreObj = validatedScores.find((v) => v.criterionId === crit.id);
      const score = scoreObj ? scoreObj.score : 0;
      const weight = crit.weight !== undefined && crit.weight > 0 ? crit.weight : 1 / criteria.length;

      totalWeight += weight;
      const ratio = crit.maxPoints > 0 ? score / crit.maxPoints : 0;
      weightedRatioSum += ratio * weight;
    }

    // Normalize in case weights do not sum exactly to 1
    const normalizedRatio = totalWeight > 0 ? weightedRatioSum / totalWeight : 0;
    calculatedTotal = Math.round(normalizedRatio * totalMaxScore * 100) / 100;
    maxPossibleScore = totalMaxScore;
  }

  // Strict bounds check: score must be between 0 and maxPossibleScore
  if (calculatedTotal < 0) calculatedTotal = 0;
  if (calculatedTotal > maxPossibleScore) calculatedTotal = maxPossibleScore;

  return {
    calculatedTotal,
    maxPossibleScore,
    validatedScores,
    warnings,
  };
}

export function validateRubricConfig(
  criteria: CriterionConfig[],
  mode: ScoringMode
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!criteria || criteria.length === 0) {
    errors.push('At least one scoring criterion must be defined.');
    return { valid: false, errors };
  }

  const ids = new Set<string>();
  let totalWeight = 0;

  for (const crit of criteria) {
    if (!crit.id || !crit.id.trim()) {
      errors.push('Criterion ID cannot be blank.');
    } else if (ids.has(crit.id)) {
      errors.push(`Duplicate criterion ID: "${crit.id}".`);
    } else {
      ids.add(crit.id);
    }

    if (!crit.name || !crit.name.trim()) {
      errors.push(`Criterion "${crit.id}" is missing a name.`);
    }

    if (crit.maxPoints <= 0) {
      errors.push(`Criterion "${crit.name || crit.id}" must have maxPoints > 0.`);
    }

    if (mode === 'weighted' && crit.weight !== undefined) {
      totalWeight += crit.weight;
    }
  }

  if (mode === 'weighted' && criteria.some((c) => c.weight !== undefined)) {
    // Check if total weights are close to 1.0 (or 100%)
    if (Math.abs(totalWeight - 1.0) > 0.05 && Math.abs(totalWeight - 100.0) > 5) {
      errors.push(`Criterion weights sum to ${totalWeight.toFixed(2)}, but expected ~1.0 (or 100%).`);
    }
  }

  return { valid: errors.length === 0, errors };
}
