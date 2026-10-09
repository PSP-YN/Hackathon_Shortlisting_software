import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserProfile, canManageConfiguration } from '@/lib/auth/rbac';
import { createAdminClient } from '@/lib/supabase/admin';
import { readMasterSubmissions, ensureDomainSheetsInitialized } from '@/lib/google/sheets';
import { SheetColumnMapping, DomainConfig } from '@/types';
import { logAuditEvent } from '@/lib/audit/logger';

export async function POST(req: NextRequest) {
  try {
    const profile = await getCurrentUserProfile();
    if (!profile || !canManageConfiguration(profile)) {
      return NextResponse.json({ error: 'Unauthorized: Super Admin access required' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const admin = createAdminClient();

    // 1. Resolve spreadsheet ID
    let spreadsheetId = body.spreadsheetId;
    if (!spreadsheetId) {
      const { data: settingRow } = await admin
        .from('system_settings')
        .select('value')
        .eq('key', 'spreadsheet_id')
        .single();
      spreadsheetId = typeof settingRow?.value === 'string' ? settingRow.value : '';
    }

    if (!spreadsheetId || !spreadsheetId.trim()) {
      return NextResponse.json(
        { error: 'No Google Spreadsheet ID configured. Please set one in Settings.' },
        { status: 400 }
      );
    }

    // 2. Fetch column mappings
    const { data: mappingsData } = await admin
      .from('sheet_column_mappings')
      .select('*');

    const mappings: SheetColumnMapping[] = (mappingsData || []).map((m) => ({
      id: m.id,
      fieldName: m.field_name,
      sheetHeader: m.sheet_header,
      isRequired: m.is_required,
      description: m.description,
    }));

    // 3. Read Master_Submissions
    const { submissions, warnings } = await readMasterSubmissions(spreadsheetId, mappings);

    // 4. Upsert submissions into Supabase
    let upsertCount = 0;
    for (const sub of submissions) {
      const { error: upsertErr } = await admin.from('submissions').upsert(
        {
          team_id: sub.teamId,
          team_name: sub.teamName,
          domain: sub.domain,
          project_title: sub.projectTitle,
          project_description: sub.projectDescription,
          problem_statement: sub.problemStatement,
          presentation_url: sub.presentationUrl,
          repo_url: sub.repoUrl,
          submission_status: sub.submissionStatus,
          raw_data: sub.rawData,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'team_id' }
      );
      if (!upsertErr) upsertCount++;
    }

    // 5. Ensure the 5 domain sheets are initialized with dynamic criterion headers
    const { data: domainRows } = await admin.from('domain_configs').select('*');
    const domainConfigs: DomainConfig[] = (domainRows || []).map((d) => ({
      id: d.id,
      domainKey: d.domain_key,
      displayName: d.display_name,
      sheetName: d.sheet_name,
      spreadsheetId: d.spreadsheet_id,
      scoringMode: d.scoring_mode,
      totalMaxScore: Number(d.total_max_score),
      criteria: d.criteria || [],
      isActive: d.is_active,
    }));

    let sheetInitResult = { initialized: [] as string[], skipped: [] as string[] };
    if (domainConfigs.length > 0) {
      sheetInitResult = await ensureDomainSheetsInitialized(spreadsheetId, domainConfigs);
    }

    // 6. Log audit event
    await logAuditEvent({
      userId: profile.id,
      action: 'SHEETS_SYNC',
      resourceType: 'spreadsheet',
      resourceId: spreadsheetId,
      metadata: { totalRead: submissions.length, upserted: upsertCount, warningsCount: warnings.length },
    });

    return NextResponse.json({
      success: true,
      submissionsSynced: upsertCount,
      totalFound: submissions.length,
      warnings,
      sheetsInitialized: sheetInitResult.initialized,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Sheets sync error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
