import { NextRequest, NextResponse } from 'next/server';
import { leaseNextJob, executeEvaluationJob } from '@/lib/queue/job-queue';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { jobId, workerId = 'worker-web-' + Math.random().toString(36).slice(2, 7) } = body;

    let targetJob = null;

    if (jobId) {
      const admin = createAdminClient();
      const { data: jobRow } = await admin
        .from('evaluation_jobs')
        .select('*')
        .eq('id', jobId)
        .single();

      if (jobRow) {
        targetJob = {
          id: jobRow.id,
          teamId: jobRow.team_id,
          domain: jobRow.domain,
          status: jobRow.status,
          currentStage: jobRow.current_stage,
          progressPct: jobRow.progress_pct,
          idempotencyKey: jobRow.idempotency_key,
          evaluationVersion: jobRow.evaluation_version,
          attempts: jobRow.attempts,
          maxAttempts: jobRow.max_attempts,
          lockedAt: jobRow.locked_at,
          lockedBy: jobRow.locked_by,
          errorMessage: jobRow.error_message,
          errorDetails: jobRow.error_details,
          isDryRun: jobRow.is_dry_run,
          createdAt: jobRow.created_at,
          updatedAt: jobRow.updated_at,
        };
      }
    } else {
      targetJob = await leaseNextJob(workerId);
    }

    if (!targetJob) {
      return NextResponse.json({ message: 'No eligible jobs in queue.', processed: false });
    }

    // Process job
    const result = await executeEvaluationJob(targetJob);

    return NextResponse.json({
      processed: true,
      jobId: targetJob.id,
      teamId: targetJob.teamId,
      resultId: result.id,
      calculatedTotal: result.calculatedTotal,
      maxPossibleScore: result.maxPossibleScore,
      needsHumanReview: result.needsHumanReview,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Job process execution error:', err);
    return NextResponse.json({ error: msg, processed: false }, { status: 500 });
  }
}
