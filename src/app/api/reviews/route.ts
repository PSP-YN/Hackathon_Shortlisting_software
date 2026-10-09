import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserProfile, canEvaluateDomain, isSuperAdmin } from '@/lib/auth/rbac';
import { createAdminClient } from '@/lib/supabase/admin';
import { logAuditEvent } from '@/lib/audit/logger';
import { DomainConfig } from '@/types';
import { getGoogleAuthClient } from '@/lib/google/auth';
import { google } from 'googleapis';

export async function POST(req: NextRequest) {
  try {
    const profile = await getCurrentUserProfile();
    if (!profile) {
      return NextResponse.json({ error: 'Unauthorized: login required' }, { status: 401 });
    }

    const body = await req.json();
    const { action, teamId, criterionScores, comments, reviewId } = body;
    const admin = createAdminClient();

    if (action === 'save_draft' || action === 'submit_review') {
      if (!teamId || !criterionScores) {
        return NextResponse.json({ error: 'teamId and criterionScores are required' }, { status: 400 });
      }

      // 1. Fetch team submission to verify domain access
      const { data: sub, error: subErr } = await admin
        .from('submissions')
        .select('*')
        .eq('team_id', teamId)
        .single();

      if (subErr || !sub) {
        return NextResponse.json({ error: `Team ${teamId} not found` }, { status: 404 });
      }

      if (!canEvaluateDomain(profile, sub.domain)) {
        return NextResponse.json(
          { error: `Forbidden: You do not have evaluation permissions for domain "${sub.domain}"` },
          { status: 403 }
        );
      }

      // 2. Fetch domain config to validate criterion maximums and compute total
      const { data: domainConfigRow } = await admin
        .from('domain_configs')
        .select('*')
        .or(`domain_key.eq.${sub.domain},display_name.eq.${sub.domain}`)
        .single();

      if (!domainConfigRow) {
        return NextResponse.json({ error: `Domain config not found for "${sub.domain}"` }, { status: 400 });
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

      // 3. Validate criterion scores against maxPoints
      let totalScore = 0;
      const sanitizedScores: Record<string, number> = {};

      for (const crit of domainConfig.criteria) {
        const rawVal = criterionScores[crit.id];
        let numVal = typeof rawVal === 'number' ? rawVal : parseFloat(rawVal || '0');
        if (isNaN(numVal) || numVal < 0) numVal = 0;
        if (numVal > crit.maxPoints) {
          return NextResponse.json(
            { error: `Score for "${crit.name}" cannot exceed ${crit.maxPoints}` },
            { status: 400 }
          );
        }
        sanitizedScores[crit.id] = numVal;
      }

      // Calculate total deterministically
      if (domainConfig.scoringMode === 'direct_points') {
        for (const crit of domainConfig.criteria) {
          totalScore += sanitizedScores[crit.id] || 0;
        }
      } else {
        let weightedRatio = 0;
        let totalWeight = 0;
        for (const crit of domainConfig.criteria) {
          const weight = crit.weight || 1 / domainConfig.criteria.length;
          totalWeight += weight;
          const ratio = crit.maxPoints > 0 ? (sanitizedScores[crit.id] || 0) / crit.maxPoints : 0;
          weightedRatio += ratio * weight;
        }
        totalScore = totalWeight > 0 ? (weightedRatio / totalWeight) * domainConfig.totalMaxScore : 0;
      }
      totalScore = Math.round(totalScore * 100) / 100;

      // 4. Fetch latest AI result if exists
      const { data: aiResult } = await admin
        .from('evaluation_results')
        .select('id')
        .eq('team_id', teamId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const newStatus = action === 'submit_review' ? 'submitted' : 'draft';

      // 5. Upsert manual review
      const { data: reviewRecord, error: reviewErr } = await admin
        .from('manual_reviews')
        .upsert(
          {
            team_id: teamId,
            evaluator_id: profile.id,
            ai_result_id: aiResult?.id || null,
            criterion_scores: sanitizedScores,
            total_score: totalScore,
            comments: comments || '',
            status: newStatus,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'team_id,evaluator_id' }
        )
        .select('*')
        .single();

      if (reviewErr) {
        return NextResponse.json({ error: reviewErr.message }, { status: 500 });
      }

      // 6. If submitted, write to domain sheet human columns
      if (action === 'submit_review') {
        await updateSheetManualScore(domainConfig, teamId, totalScore, comments || '');
      }

      // 7. Log audit event
      await logAuditEvent({
        userId: profile.id,
        action: action === 'submit_review' ? 'MANUAL_REVIEW_SUBMITTED' : 'MANUAL_REVIEW_DRAFT_SAVED',
        resourceType: 'manual_review',
        resourceId: reviewRecord.id,
        metadata: { teamId, totalScore, status: newStatus },
      });

      return NextResponse.json({
        success: true,
        review: reviewRecord,
        totalScore,
        status: newStatus,
      });
    }

    if (action === 'approve') {
      if (!profile || profile.role !== 'super_admin') {
        return NextResponse.json({ error: 'Unauthorized: Only Super Admin can approve reviews' }, { status: 403 });
      }
      if (!reviewId) {
        return NextResponse.json({ error: 'reviewId is required' }, { status: 400 });
      }

      const { data: updated, error: approveErr } = await admin
        .from('manual_reviews')
        .update({
          status: 'approved',
          approved_by: profile.id,
          approved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', reviewId)
        .select('*')
        .single();

      if (approveErr) {
        return NextResponse.json({ error: approveErr.message }, { status: 500 });
      }

      await logAuditEvent({
        userId: profile.id,
        action: 'MANUAL_REVIEW_APPROVED',
        resourceType: 'manual_review',
        resourceId: reviewId,
        metadata: { teamId: updated.team_id, approvedScore: updated.total_score },
      });

      return NextResponse.json({ success: true, review: updated });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Review API error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function updateSheetManualScore(
  domainConfig: DomainConfig,
  teamId: string,
  totalScore: number,
  comments: string
): Promise<void> {
  try {
    const admin = createAdminClient();
    let spreadsheetId = domainConfig.spreadsheetId;
    if (!spreadsheetId) {
      const { data: settingRow } = await admin
        .from('system_settings')
        .select('value')
        .eq('key', 'spreadsheet_id')
        .single();
      spreadsheetId = typeof settingRow?.value === 'string' ? settingRow.value : '';
    }

    if (!spreadsheetId || !spreadsheetId.trim()) return;

    const { auth } = getGoogleAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const sheetName = domainConfig.sheetName;

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:ZZ500`,
    });

    const rows = res.data.values;
    if (!rows || rows.length < 2) return;

    const headers = rows[0].map((h) => String(h).trim().toLowerCase());
    const scoreColIdx = headers.indexOf('human-adjusted score');
    const commentColIdx = headers.indexOf('reviewer comments');
    const reviewStatusColIdx = headers.indexOf('review status');

    if (scoreColIdx === -1 && commentColIdx === -1) return;

    let targetRowIndex = -1;
    for (let r = 1; r < rows.length; r++) {
      if (rows[r] && String(rows[r][0]).trim() === teamId) {
        targetRowIndex = r + 1;
        break;
      }
    }

    if (targetRowIndex === -1) return;

    if (scoreColIdx !== -1) {
      const colLetter = String.fromCharCode(65 + scoreColIdx);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!${colLetter}${targetRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[totalScore]] },
      });
    }

    if (commentColIdx !== -1) {
      const colLetter = String.fromCharCode(65 + commentColIdx);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!${colLetter}${targetRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[comments]] },
      });
    }

    if (reviewStatusColIdx !== -1) {
      const colLetter = String.fromCharCode(65 + reviewStatusColIdx);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!${colLetter}${targetRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['Human Reviewed']] },
      });
    }
  } catch (err) {
    console.warn('Could not sync human review to Google Sheet:', err);
  }
}
