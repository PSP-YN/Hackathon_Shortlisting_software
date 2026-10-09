import { z } from 'zod';

export const CriterionScoreResultSchema = z.object({
  criterionId: z.string().min(1, 'Criterion ID is required'),
  score: z.number().min(0, 'Score cannot be negative'),
  maxScore: z.number().positive('Max score must be greater than zero'),
  justification: z.string().min(5, 'Justification must provide concrete evidence'),
  slideOrPageRef: z.string().optional().default('N/A'),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const AiEvaluationRawResponseSchema = z.object({
  criterionScores: z.array(CriterionScoreResultSchema),
  summary: z.string().min(10, 'Summary must be detailed'),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  missingEvidence: z.array(z.string()).default([]),
  technicalRisks: z.array(z.string()).default([]),
  clarificationFlags: z.array(z.string()).default([]),
  needsHumanReview: z.boolean().default(false),
});

export type RawAiEvaluationOutput = z.infer<typeof AiEvaluationRawResponseSchema>;
