import { createAdminClient } from '@/lib/supabase/admin';
import { EvaluationJob, JobStatus, Submission, DomainConfig, EvaluationResult } from '@/types';
import { fetchAndExtractPresentation } from '@/lib/google/drive';
import { GeminiEvaluationProvider } from '@/lib/ai/gemini';
import { writeEvaluationResultToDomainSheet, updateMasterSheetStatus } from '@/lib/google/sheets';
import { logAuditEvent } from '@/lib/audit/logger';

export interface CreateJobOptions {
  teamId: string;
  domain: string;
  evaluationVersion?: number;
  isDryRun?: boolean;
}

export async function createOrQueueEvaluationJob(
  options: CreateJobOptions,
  userId?: string
): Promise<{ job: EvaluationJob | null; created: boolean; message: string }> {
  const admin = createAdminClient();
  const version = options.evaluationVersion || 1;
  const idempotencyKey = `${options.teamId}_v${version}`;

  // Check if active job already exists
  const { data: existingJob } = await admin
    .from('evaluation_jobs')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .single();

  if (existingJob) {
    if (['completed', 'needs_human_review'].includes(existingJob.status)) {
      return {
        job: mapJobRecord(existingJob),
        created: false,
        message: `Evaluation already completed for team ${options.teamId} (Version ${version}).`,
      };
    }
    if (!['failed', 'cancelled'].includes(existingJob.status)) {
      return {
        job: mapJobRecord(existingJob),
        created: false,
        message: `Evaluation job already running or queued for team ${options.teamId} (Status: ${existingJob.status}).`,
      };
    }
  }

  // Create new or reset failed job
  const newJobRecord = {
    team_id: options.teamId,
    domain: options.domain,
    status: 'queued' as JobStatus,
    current_stage: 'Queued for processing',
    progress_pct: 5,
    idempotency_key: idempotencyKey,
    evaluation_version: version,
    attempts: 0,
    max_attempts: 3,
    is_dry_run: options.isDryRun ?? false,
    error_message: null,
    locked_at: null,
    locked_by: null,
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error } = await admin
    .from('evaluation_jobs')
    .upsert(newJobRecord, { onConflict: 'idempotency_key' })
    .select('*')
    .single();

  if (error || !inserted) {
    throw new Error(`Failed to queue job for team ${options.teamId}: ${error?.message}`);
  }

  await logAuditEvent({
    userId,
    action: 'JOB_QUEUED',
    resourceType: 'evaluation_job',
    resourceId: inserted.id,
    metadata: { teamId: options.teamId, domain: options.domain, isDryRun: options.isDryRun },
  });

  return {
    job: mapJobRecord(inserted),
    created: true,
    message: `Job queued successfully for team ${options.teamId}.`,
  };
}

export async function leaseNextJob(workerId: string): Promise<EvaluationJob | null> {
  const admin = createAdminClient();

  // Find oldest queued job or timed-out job (lock timeout 5 minutes)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  // Use atomic lease update
  const { data: eligibleJobs, error: selectErr } = await admin
    .from('evaluation_jobs')
    .select('*')
    .or(`status.eq.queued,and(status.not.in.(completed,needs_human_review,cancelled,failed),locked_at.lt.${fiveMinutesAgo})`)
    .order('created_at', { ascending: true })
    .limit(1);

  if (selectErr || !eligibleJobs || eligibleJobs.length === 0) {
    return null;
  }

  const candidate = eligibleJobs[0];

  // Try to acquire lock
  const { data: lockedJob, error: lockErr } = await admin
    .from('evaluation_jobs')
    .update({
      locked_at: new Date().toISOString(),
      locked_by: workerId,
      status: 'fetching_submission' as JobStatus,
      current_stage: 'Leased by worker; fetching submission details',
      progress_pct: 10,
      attempts: candidate.attempts + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', candidate.id)
    .select('*')
    .single();

  if (lockErr || !lockedJob) {
    return null;
  }

  return mapJobRecord(lockedJob);
}

export async function executeEvaluationJob(
  job: EvaluationJob,
  geminiApiKey?: string,
  overrideModelId?: string
): Promise<EvaluationResult> {
  const admin = createAdminClient();

  try {
    // 1. Fetch submission details
    await updateStage(job.id, 'fetching_submission', 'Retrieving submission and presentation details', 20);
    const { data: submissionRow, error: subError } = await admin
      .from('submissions')
      .select('*')
      .eq('team_id', job.teamId)
      .single();

    if (subError || !submissionRow) {
      throw new Error(`Submission record not found for Team ID: ${job.teamId}`);
    }

    const submission: Submission = {
      id: submissionRow.id,
      teamId: submissionRow.team_id,
      teamName: submissionRow.team_name,
      domain: submissionRow.domain,
      projectTitle: submissionRow.project_title,
      projectDescription: submissionRow.project_description,
      problemStatement: submissionRow.problem_statement,
      presentationUrl: submissionRow.presentation_url,
      repoUrl: submissionRow.repo_url,
    };

    // 2. Fetch Domain Configuration
    const { data: domainConfigRow, error: domainError } = await admin
      .from('domain_configs')
      .select('*')
      .or(`domain_key.eq.${job.domain},display_name.eq.${job.domain}`)
      .single();

    if (domainError || !domainConfigRow) {
      throw new Error(`No domain configuration found for domain: ${job.domain}`);
    }

    const domainConfig: DomainConfig = {
      id: domainConfigRow.id,
      domainKey: domainConfigRow.domain_key,
      displayName: domainConfigRow.display_name,
      sheetName: domainConfigRow.sheet_name,
      spreadsheetId: domainConfigRow.spreadsheet_id,
      scoringMode: domainConfigRow.scoring_mode,
      totalMaxScore: Number(domainConfigRow.total_max_score),
      criteria: domainConfigRow.criteria || [],
      isActive: domainConfigRow.is_active,
    };

    // 3. Extract presentation content
    await updateStage(job.id, 'extracting_content', 'Accessing authorized presentation and extracting slide text', 40);
    const presentation = await fetchAndExtractPresentation(submission.presentationUrl);

    // 4. Evaluate with Gemini
    await updateStage(
      job.id,
      'evaluating_gemini',
      `Evaluating ${domainConfig.criteria.length} criteria with Google Gemini`,
      60
    );
    const provider = new GeminiEvaluationProvider(geminiApiKey, overrideModelId);
    const evaluationOutput = await provider.evaluateSubmission({
      submission,
      domainConfig,
      presentation,
    });

    // 5. Validating scores
    await updateStage(job.id, 'validating_scores', 'Validating score bounds and computing final arithmetic', 80);

    // 6. Write to Google Sheets
    let writtenToSheetAt: string | null = null;
    let sheetRowIndex: number | null = null;

    if (!job.isDryRun) {
      await updateStage(job.id, 'writing_sheets', 'Writing structured result into Google Sheets domain sheet', 90);

      // Fetch global spreadsheet ID from settings if domain config does not have a dedicated one
      let targetSpreadsheetId = domainConfig.spreadsheetId;
      if (!targetSpreadsheetId) {
        const { data: settingRow } = await admin
          .from('system_settings')
          .select('value')
          .eq('key', 'spreadsheet_id')
          .single();
        targetSpreadsheetId = typeof settingRow?.value === 'string' ? settingRow.value : '';
      }

      if (targetSpreadsheetId && targetSpreadsheetId.trim().length > 0) {
        const tempResult: EvaluationResult = {
          id: '',
          jobId: job.id,
          teamId: submission.teamId,
          domain: job.domain,
          aiProvider: provider.getProviderName(),
          modelId: provider.getModelId(),
          scoringMode: domainConfig.scoringMode,
          criterionScores: evaluationOutput.criterionScores,
          calculatedTotal: evaluationOutput.calculatedTotal,
          maxPossibleScore: evaluationOutput.maxPossibleScore,
          feedbackSummary: evaluationOutput.summary,
          strengths: evaluationOutput.strengths,
          weaknesses: evaluationOutput.weaknesses,
          missingEvidence: evaluationOutput.missingEvidence,
          technicalRisks: evaluationOutput.technicalRisks,
          clarificationFlags: evaluationOutput.clarificationFlags,
          needsHumanReview: evaluationOutput.needsHumanReview,
          extractedContentSummary: evaluationOutput.extractedContentSummary,
          createdAt: new Date().toISOString(),
        };

        const writeRes = await writeEvaluationResultToDomainSheet(
          targetSpreadsheetId,
          domainConfig,
          tempResult,
          submission.teamName,
          submission.projectTitle,
          false
        );

        writtenToSheetAt = new Date().toISOString();
        sheetRowIndex = writeRes.rowIndex;

        // Update status in Master_Submissions
        await updateMasterSheetStatus(
          targetSpreadsheetId,
          submission.teamId,
          evaluationOutput.needsHumanReview ? 'Needs Human Review' : 'Evaluated',
          writtenToSheetAt
        );
      }
    }

    // 7. Save Evaluation Result to DB
    const finalResultRecord = {
      job_id: job.id,
      team_id: submission.teamId,
      domain: job.domain,
      ai_provider: provider.getProviderName(),
      model_id: provider.getModelId(),
      scoring_mode: domainConfig.scoringMode,
      criterion_scores: evaluationOutput.criterionScores,
      calculated_total: evaluationOutput.calculatedTotal,
      max_possible_score: evaluationOutput.maxPossibleScore,
      feedback_summary: evaluationOutput.summary,
      strengths: evaluationOutput.strengths,
      weaknesses: evaluationOutput.weaknesses,
      missing_evidence: evaluationOutput.missingEvidence,
      technical_risks: evaluationOutput.technicalRisks,
      clarification_flags: evaluationOutput.clarificationFlags,
      needs_human_review: evaluationOutput.needsHumanReview,
      extracted_content_summary: evaluationOutput.extractedContentSummary,
      written_to_sheet_at: writtenToSheetAt,
      sheet_row_index: sheetRowIndex,
      created_at: new Date().toISOString(),
    };

    const { data: savedResult, error: saveErr } = await admin
      .from('evaluation_results')
      .upsert(finalResultRecord, { onConflict: 'team_id,job_id' })
      .select('*')
      .single();

    if (saveErr) {
      throw new Error(`Failed to save evaluation result: ${saveErr.message}`);
    }

    // 8. Mark job completed
    const finalStatus: JobStatus = evaluationOutput.needsHumanReview ? 'needs_human_review' : 'completed';
    await admin
      .from('evaluation_jobs')
      .update({
        status: finalStatus,
        current_stage: evaluationOutput.needsHumanReview
          ? 'Completed - Flagged for Human Review'
          : 'Evaluation Successfully Completed',
        progress_pct: 100,
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    return {
      id: savedResult.id,
      jobId: job.id,
      teamId: submission.teamId,
      domain: job.domain,
      aiProvider: savedResult.ai_provider,
      modelId: savedResult.model_id,
      scoringMode: savedResult.scoring_mode,
      criterionScores: savedResult.criterion_scores,
      calculatedTotal: Number(savedResult.calculated_total),
      maxPossibleScore: Number(savedResult.max_possible_score),
      feedbackSummary: savedResult.feedback_summary,
      strengths: savedResult.strengths,
      weaknesses: savedResult.weaknesses,
      missingEvidence: savedResult.missing_evidence,
      technicalRisks: savedResult.technical_risks,
      clarificationFlags: savedResult.clarification_flags,
      needsHumanReview: savedResult.needs_human_review,
      extractedContentSummary: savedResult.extracted_content_summary,
      writtenToSheetAt: savedResult.written_to_sheet_at,
      sheetRowIndex: savedResult.sheet_row_index,
      createdAt: savedResult.created_at,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Evaluation job ${job.id} failed:`, err);

    await admin
      .from('evaluation_jobs')
      .update({
        status: 'failed' as JobStatus,
        current_stage: `Failed: ${errorMsg.slice(0, 100)}`,
        error_message: errorMsg,
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    throw err;
  }
}

async function updateStage(
  jobId: string,
  status: JobStatus,
  stageDescription: string,
  progressPct: number
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from('evaluation_jobs')
    .update({
      status,
      current_stage: stageDescription,
      progress_pct: progressPct,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

function mapJobRecord(record: Record<string, unknown>): EvaluationJob {
  return {
    id: String(record.id),
    teamId: String(record.team_id),
    domain: String(record.domain),
    status: record.status as JobStatus,
    currentStage: String(record.current_stage || ''),
    progressPct: Number(record.progress_pct || 0),
    idempotencyKey: String(record.idempotency_key),
    evaluationVersion: Number(record.evaluation_version || 1),
    attempts: Number(record.attempts || 0),
    maxAttempts: Number(record.max_attempts || 3),
    lockedAt: record.locked_at ? String(record.locked_at) : null,
    lockedBy: record.locked_by ? String(record.locked_by) : null,
    errorMessage: record.error_message ? String(record.error_message) : null,
    errorDetails: (record.error_details as Record<string, unknown>) || null,
    isDryRun: Boolean(record.is_dry_run),
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}
