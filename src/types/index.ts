export type UserRole = 'super_admin' | 'domain_evaluator' | 'read_only_observer';

export interface UserProfile {
  id: string;
  email: string;
  fullName?: string;
  role: UserRole;
  assignedDomains: string[];
  createdAt: string;
  updatedAt: string;
}

export type ScoringMode = 'direct_points' | 'weighted';

export type FinalScorePolicy = 'ai_provisional' | 'human_reviewed' | 'admin_approved';

export interface CriterionConfig {
  id: string;
  name: string;
  description: string;
  maxPoints: number;
  weight?: number; // E.g., 0.20 for 20%
  scoringInstructions: string;
  requiredEvidence: string;
}

export interface DomainConfig {
  id: string;
  domainKey: string; // e.g. "Domain_1" or "FinTech"
  displayName: string;
  sheetName: string; // Target sheet name in the workbook
  spreadsheetId?: string | null; // Optional dedicated spreadsheet ID for complete physical domain isolation
  scoringMode: ScoringMode;
  totalMaxScore: number;
  criteria: CriterionConfig[];
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface SheetColumnMapping {
  id: string;
  fieldName: string;
  sheetHeader: string;
  isRequired: boolean;
  description?: string;
}

export interface Submission {
  id: string;
  teamId: string;
  teamName: string;
  domain: string;
  projectTitle: string;
  projectDescription?: string;
  problemStatement?: string;
  presentationUrl: string;
  repoUrl?: string;
  submissionStatus?: string;
  rawData?: Record<string, string>;
  lastSyncedAt?: string;
}

export type JobStatus =
  | 'pending'
  | 'queued'
  | 'fetching_submission'
  | 'extracting_content'
  | 'evaluating_gemini'
  | 'validating_scores'
  | 'writing_sheets'
  | 'completed'
  | 'needs_human_review'
  | 'failed'
  | 'cancelled';

export interface EvaluationJob {
  id: string;
  teamId: string;
  domain: string;
  status: JobStatus;
  currentStage: string;
  progressPct: number;
  idempotencyKey: string;
  evaluationVersion: number;
  attempts: number;
  maxAttempts: number;
  lockedAt?: string | null;
  lockedBy?: string | null;
  errorMessage?: string | null;
  errorDetails?: Record<string, unknown> | null;
  isDryRun: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CriterionScoreResult {
  criterionId: string;
  score: number;
  maxScore: number;
  justification: string;
  slideOrPageRef?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface AiEvaluationOutput {
  criterionScores: CriterionScoreResult[];
  calculatedTotal: number;
  maxPossibleScore: number;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  missingEvidence: string[];
  technicalRisks: string[];
  clarificationFlags: string[];
  needsHumanReview: boolean;
  extractedContentSummary?: string;
}

export interface EvaluationResult {
  id: string;
  jobId?: string | null;
  teamId: string;
  domain: string;
  aiProvider: string;
  modelId: string;
  scoringMode: ScoringMode;
  criterionScores: CriterionScoreResult[];
  calculatedTotal: number;
  maxPossibleScore: number;
  feedbackSummary: string;
  strengths: string[];
  weaknesses: string[];
  missingEvidence: string[];
  technicalRisks: string[];
  clarificationFlags: string[];
  needsHumanReview: boolean;
  extractedContentSummary?: string;
  writtenToSheetAt?: string | null;
  sheetRowIndex?: number | null;
  createdAt: string;
}

export type ReviewStatus = 'draft' | 'submitted' | 'approved' | 'returned';

export interface ManualReview {
  id: string;
  teamId: string;
  evaluatorId: string;
  aiResultId?: string | null;
  criterionScores: Record<string, number>;
  totalScore: number;
  comments: string;
  status: ReviewStatus;
  approvedBy?: string | null;
  approvedAt?: string | null;
  writtenToSheetAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  createdAt: string;
}

export interface SystemSettings {
  spreadsheetId: string;
  scoringMode: ScoringMode;
  finalScorePolicy: FinalScorePolicy;
  geminiModel: string;
  concurrencyLimit: number;
  dryRunMode: boolean;
}
