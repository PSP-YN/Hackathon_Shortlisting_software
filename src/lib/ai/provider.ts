import { Submission, DomainConfig, AiEvaluationOutput } from '@/types';
import { ExtractedPresentationContent } from '@/lib/google/drive';

export interface AiEvaluationInput {
  submission: Submission;
  domainConfig: DomainConfig;
  presentation: ExtractedPresentationContent;
}

export interface AiEvaluationProvider {
  getProviderName(): string;
  getModelId(): string;
  evaluateSubmission(input: AiEvaluationInput): Promise<AiEvaluationOutput>;
}
