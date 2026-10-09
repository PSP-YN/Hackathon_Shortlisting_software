import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserProfile, canManageQueue } from '@/lib/auth/rbac';
import { createOrQueueEvaluationJob } from '@/lib/queue/job-queue';
import { createAdminClient } from '@/lib/supabase/admin';
import { logAuditEvent } from '@/lib/audit/logger';

export async function POST(req: NextRequest) {
  try {
    const profile = await getCurrentUserProfile();
    if (!profile || !canManageQueue(profile)) {
      return NextResponse.json({ error: 'Unauthorized: Super Admin access required' }, { status: 403 });
    }

    const body = await req.json();
    const { action, teamId, domain, teamIds, jobId, isDryRun } = body;
    const admin = createAdminClient();

    if (action === 'evaluate_one') {
      if (!teamId || !domain) {
        return NextResponse.json({ error: 'teamId and domain are required' }, { status: 400 });
      }

      const result = await createOrQueueEvaluationJob(
        { teamId, domain, isDryRun: Boolean(isDryRun) },
        profile.id
      );
      return NextResponse.json(result);
    }

    if (action === 'evaluate_selected') {
      if (!Array.isArray(teamIds) || teamIds.length === 0) {
        return NextResponse.json({ error: 'teamIds array is required' }, { status: 400 });
      }

      // Fetch domain for each team
      const { data: subs } = await admin
        .from('submissions')
        .select('team_id, domain')
        .in('team_id', teamIds);

      const results = [];
      for (const sub of subs || []) {
        try {
          const res = await createOrQueueEvaluationJob(
            { teamId: sub.team_id, domain: sub.domain, isDryRun: Boolean(isDryRun) },
            profile.id
          );
          results.push(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ teamId: sub.team_id, error: msg });
        }
      }

      return NextResponse.json({ queued: results.length, details: results });
    }

    if (action === 'evaluate_all') {
      let query = admin.from('submissions').select('team_id, domain');
      if (domain && domain !== 'all') {
        query = query.eq('domain', domain);
      }
      const { data: subs, error } = await query;
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const results = [];
      for (const sub of subs || []) {
        try {
          const res = await createOrQueueEvaluationJob(
            { teamId: sub.team_id, domain: sub.domain, isDryRun: Boolean(isDryRun) },
            profile.id
          );
          results.push(res);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ teamId: sub.team_id, error: msg });
        }
      }

      return NextResponse.json({ total: subs?.length || 0, queued: results });
    }

    if (action === 'cancel') {
      if (!jobId) {
        return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
      }

      await admin
        .from('evaluation_jobs')
        .update({
          status: 'cancelled',
          current_stage: 'Cancelled by administrator',
          locked_at: null,
          locked_by: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      await logAuditEvent({
        userId: profile.id,
        action: 'JOB_CANCELLED',
        resourceType: 'evaluation_job',
        resourceId: jobId,
      });

      return NextResponse.json({ success: true, message: 'Job cancelled' });
    }

    if (action === 'retry_failed') {
      if (!jobId) {
        return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
      }

      await admin
        .from('evaluation_jobs')
        .update({
          status: 'queued',
          current_stage: 'Queued for retry',
          progress_pct: 0,
          error_message: null,
          locked_at: null,
          locked_by: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      await logAuditEvent({
        userId: profile.id,
        action: 'JOB_RETRIED',
        resourceType: 'evaluation_job',
        resourceId: jobId,
      });

      return NextResponse.json({ success: true, message: 'Job re-queued for processing' });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Queue actions error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
