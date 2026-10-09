import { describe, it, expect } from 'vitest';
import { calculateFinalScore, validateRubricConfig } from '../src/lib/ai/scoring';
import { AiEvaluationRawResponseSchema } from '../src/lib/ai/schemas';
import { CriterionConfig, CriterionScoreResult } from '../src/types';

describe('AI Scoring Engine & Validation', () => {
  const criteria: CriterionConfig[] = [
    { id: 'c1', name: 'Innovation', description: '', maxPoints: 20, weight: 0.4, scoringInstructions: '', requiredEvidence: '' },
    { id: 'c2', name: 'Feasibility', description: '', maxPoints: 30, weight: 0.6, scoringInstructions: '', requiredEvidence: '' },
  ];

  it('validates a valid rubric config', () => {
    const res = validateRubricConfig(criteria, 'weighted');
    expect(res.valid).toBe(true);
    expect(res.errors.length).toBe(0);
  });

  it('detects invalid rubric configs (negative maxPoints, duplicate IDs)', () => {
    const badCriteria: CriterionConfig[] = [
      { id: 'c1', name: 'Test', description: '', maxPoints: -5, scoringInstructions: '', requiredEvidence: '' },
      { id: 'c1', name: 'Duplicate', description: '', maxPoints: 10, scoringInstructions: '', requiredEvidence: '' },
    ];
    const res = validateRubricConfig(badCriteria, 'direct_points');
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('Duplicate criterion ID: "c1".');
  });

  it('calculates direct points correctly and clamps bounds', () => {
    const rawScores: CriterionScoreResult[] = [
      { criterionId: 'c1', score: 25, maxScore: 20, justification: 'good', confidence: 'high' }, // Exceeds max (20), should clamp
      { criterionId: 'c2', score: 15, maxScore: 30, justification: 'ok', confidence: 'medium' },
    ];

    const result = calculateFinalScore(criteria, rawScores, 'direct_points', 100);
    // c1 clamped to 20 + c2 15 = 35
    expect(result.calculatedTotal).toBe(35);
    expect(result.maxPossibleScore).toBe(50);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('exceeded max allowed');
  });

  it('calculates weighted scores correctly', () => {
    const rawScores: CriterionScoreResult[] = [
      { criterionId: 'c1', score: 20, maxScore: 20, justification: 'good', confidence: 'high' }, // 100% of 0.4 weight
      { criterionId: 'c2', score: 15, maxScore: 30, justification: 'ok', confidence: 'medium' }, // 50% of 0.6 weight
    ];

    const result = calculateFinalScore(criteria, rawScores, 'weighted', 100);
    // (1.0 * 0.4) + (0.5 * 0.6) = 0.4 + 0.3 = 0.7 ratio
    // Total = 0.7 * 100 = 70
    expect(result.calculatedTotal).toBe(70);
    expect(result.maxPossibleScore).toBe(100);
  });

  it('handles missing criteria by defaulting to 0', () => {
    const rawScores: CriterionScoreResult[] = [
      { criterionId: 'c1', score: 20, maxScore: 20, justification: 'good', confidence: 'high' },
      // c2 is missing
    ];

    const result = calculateFinalScore(criteria, rawScores, 'direct_points', 100);
    expect(result.calculatedTotal).toBe(20);
    expect(result.warnings).toContain('Missing evaluation for criterion "Feasibility" (ID: c2). Defaulting to 0.');
  });
});

describe('Zod Schema Validation', () => {
  it('validates a correct Gemini JSON output', () => {
    const validJson = {
      criterionScores: [
        { criterionId: 'c1', score: 10, maxScore: 20, justification: 'Valid reason', confidence: 'high', slideOrPageRef: 'Slide 2' }
      ],
      summary: 'A strong project.',
      strengths: ['Great idea'],
      weaknesses: ['Poor execution'],
      missingEvidence: [],
      technicalRisks: [],
      clarificationFlags: [],
      needsHumanReview: false
    };

    const parsed = AiEvaluationRawResponseSchema.parse(validJson);
    expect(parsed.summary).toBe('A strong project.');
  });

  it('throws Zod error on invalid fields', () => {
    const invalidJson = {
      criterionScores: [
        { criterionId: '', score: -5, maxScore: 0, justification: 'bad', confidence: 'high' } // Score < 0, ID blank, maxScore 0
      ],
      summary: 'short', // Min length 10
    };

    const res = AiEvaluationRawResponseSchema.safeParse(invalidJson);
    expect(res.success).toBe(false);
  });
});
