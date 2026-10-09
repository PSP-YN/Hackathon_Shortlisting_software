import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserProfile, canManageConfiguration } from '@/lib/auth/rbac';
import { testSpreadsheetConnection } from '@/lib/google/sheets';

export async function POST(req: NextRequest) {
  try {
    const profile = await getCurrentUserProfile();
    if (!profile || !canManageConfiguration(profile)) {
      return NextResponse.json({ error: 'Unauthorized: Super Admin access required' }, { status: 403 });
    }

    const { spreadsheetId } = await req.json();
    if (!spreadsheetId || !spreadsheetId.trim()) {
      return NextResponse.json({ error: 'spreadsheetId is required' }, { status: 400 });
    }

    const result = await testSpreadsheetConnection(spreadsheetId.trim());
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
