import { google } from 'googleapis';
import { getGoogleAuthClient } from './auth';
import { Submission, DomainConfig, EvaluationResult, SheetColumnMapping } from '@/types';

export interface SheetConnectionTestResult {
  success: boolean;
  title?: string;
  sheetNames?: string[];
  serviceAccountEmail?: string;
  error?: string;
}

export async function testSpreadsheetConnection(spreadsheetId: string): Promise<SheetConnectionTestResult> {
  try {
    const { auth, clientEmail } = getGoogleAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const metadata = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'properties.title,sheets.properties.title',
    });

    const sheetNames = metadata.data.sheets?.map((s) => s.properties?.title || '') || [];

    return {
      success: true,
      title: metadata.data.properties?.title || 'Untitled Spreadsheet',
      sheetNames,
      serviceAccountEmail: clientEmail,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
    };
  }
}

export async function readMasterSubmissions(
  spreadsheetId: string,
  mappings: SheetColumnMapping[],
  sheetTabName: string = 'Master_Submissions'
): Promise<{ submissions: Submission[]; warnings: string[] }> {
  const { auth } = getGoogleAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTabName}!A1:ZZ1000`,
  });

  const rows = response.data.values;
  if (!rows || rows.length < 2) {
    return { submissions: [], warnings: ['No submission rows found in ' + sheetTabName] };
  }

  const headerRow = rows[0].map((h) => String(h).trim().toLowerCase());
  const warnings: string[] = [];

  // Helper to find column index from mapping
  const getColIndex = (fieldName: string, fallbackHeaders: string[]): number => {
    const mapping = mappings.find((m) => m.fieldName === fieldName);
    if (mapping) {
      const idx = headerRow.indexOf(mapping.sheetHeader.trim().toLowerCase());
      if (idx !== -1) return idx;
    }
    // Try fallback common names
    for (const fb of fallbackHeaders) {
      const idx = headerRow.indexOf(fb.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const teamIdIdx = getColIndex('team_id', ['team id', 'team_id', 'id', 'submission id']);
  const teamNameIdx = getColIndex('team_name', ['team name', 'team_name', 'name']);
  const domainIdx = getColIndex('domain', ['domain', 'track', 'category']);
  const titleIdx = getColIndex('project_title', ['project title', 'title', 'project name']);
  const descIdx = getColIndex('project_description', ['project description', 'description', 'summary']);
  const problemIdx = getColIndex('problem_statement', ['problem statement', 'problem', 'problem_statement']);
  const presentationIdx = getColIndex('presentation_url', ['presentation url', 'ppt link', 'drive link', 'slides url', 'presentation link']);
  const repoIdx = getColIndex('repo_url', ['github repository url', 'repo url', 'github', 'github link']);
  const statusIdx = getColIndex('submission_status', ['submission status', 'status']);

  if (teamIdIdx === -1) {
    warnings.push('Column "Team ID" not found. Falling back to Row Index as temporary identifier.');
  }
  if (presentationIdx === -1) {
    warnings.push('Warning: "Presentation URL" column not detected.');
  }

  const submissions: Submission[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0 || row.every((c: unknown) => !c || String(c).trim() === '')) {
      continue; // Skip empty rows
    }

    const teamId = teamIdIdx !== -1 && row[teamIdIdx] ? String(row[teamIdIdx]).trim() : `TEAM_ROW_${i + 1}`;
    const teamName = teamNameIdx !== -1 && row[teamNameIdx] ? String(row[teamNameIdx]).trim() : `Team ${teamId}`;
    const domain = domainIdx !== -1 && row[domainIdx] ? String(row[domainIdx]).trim() : 'General';
    const projectTitle = titleIdx !== -1 && row[titleIdx] ? String(row[titleIdx]).trim() : 'Untitled Project';
    const projectDescription = descIdx !== -1 && row[descIdx] ? String(row[descIdx]).trim() : '';
    const problemStatement = problemIdx !== -1 && row[problemIdx] ? String(row[problemIdx]).trim() : '';
    const presentationUrl = presentationIdx !== -1 && row[presentationIdx] ? String(row[presentationIdx]).trim() : '';
    const repoUrl = repoIdx !== -1 && row[repoIdx] ? String(row[repoIdx]).trim() : '';
    const submissionStatus = statusIdx !== -1 && row[statusIdx] ? String(row[statusIdx]).trim() : 'submitted';

    // Collect all raw row values mapped to original headers
    const rawData: Record<string, string> = {};
    rows[0].forEach((headerName: unknown, colIndex: number) => {
      rawData[String(headerName)] = row[colIndex] ? String(row[colIndex]).trim() : '';
    });

    submissions.push({
      id: teamId,
      teamId,
      teamName,
      domain,
      projectTitle,
      projectDescription,
      problemStatement,
      presentationUrl,
      repoUrl,
      submissionStatus,
      rawData,
      lastSyncedAt: new Date().toISOString(),
    });
  }

  return { submissions, warnings };
}

export function buildDomainSheetHeaders(domainConfig: DomainConfig): string[] {
  const headers: string[] = ['Team ID', 'Team Name', 'Project Title'];

  // Dynamic criterion columns
  for (const crit of domainConfig.criteria) {
    headers.push(`Score: ${crit.name} (Max ${crit.maxPoints})`);
    headers.push(`Justification: ${crit.name}`);
  }

  // Trailing summary and audit columns
  headers.push(
    'Total Score',
    'Max Possible Score',
    'Evaluation Status',
    'AI Provider',
    'Model Identifier',
    'Evaluation Timestamp',
    'Review Status',
    'Human-Adjusted Score',
    'Reviewer Comments'
  );

  return headers;
}

export async function ensureDomainSheetsInitialized(
  spreadsheetId: string,
  domainConfigs: DomainConfig[]
): Promise<{ initialized: string[]; skipped: string[] }> {
  const { auth } = getGoogleAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });

  const existingSheetTitles = new Set(
    metadata.data.sheets?.map((s) => s.properties?.title || '') || []
  );

  const initialized: string[] = [];
  const skipped: string[] = [];

  for (const config of domainConfigs) {
    const sheetName = config.sheetName;

    if (!existingSheetTitles.has(sheetName)) {
      // Add sheet
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: sheetName,
                  gridProperties: { rowCount: 100, columnCount: 30 },
                },
              },
            },
          ],
        },
      });
      existingSheetTitles.add(sheetName);
    }

    // Check if headers already exist
    const headerCheck = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:Z1`,
    });

    const expectedHeaders = buildDomainSheetHeaders(config);

    if (!headerCheck.data.values || headerCheck.data.values.length === 0 || headerCheck.data.values[0].length === 0) {
      // Write headers
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [expectedHeaders],
        },
      });
      initialized.push(sheetName);
    } else {
      skipped.push(sheetName);
    }
  }

  return { initialized, skipped };
}

export async function writeEvaluationResultToDomainSheet(
  spreadsheetId: string,
  domainConfig: DomainConfig,
  result: EvaluationResult,
  teamName: string,
  projectTitle: string,
  isDryRun: boolean = false
): Promise<{ rowIndex: number; action: 'updated' | 'appended' | 'dry_run' }> {
  if (isDryRun) {
    return { rowIndex: -1, action: 'dry_run' };
  }

  const { auth } = getGoogleAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetName = domainConfig.sheetName;

  // 1. Fetch current data in sheet to locate row index or append
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:ZZ500`,
  });

  const rows = response.data.values || [];
  const expectedHeaders = buildDomainSheetHeaders(domainConfig);

  if (rows.length === 0) {
    // Write headers first if sheet was completely empty
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [expectedHeaders] },
    });
    rows.push(expectedHeaders);
  }

  // 2. Build the result row values
  const rowValues: (string | number)[] = [result.teamId, teamName, projectTitle];

  for (const crit of domainConfig.criteria) {
    const scoreItem = result.criterionScores.find((s) => s.criterionId === crit.id);
    rowValues.push(scoreItem ? scoreItem.score : 0);
    rowValues.push(scoreItem ? scoreItem.justification : 'No evidence evaluated');
  }

  rowValues.push(
    result.calculatedTotal,
    result.maxPossibleScore,
    result.needsHumanReview ? 'Needs Human Review' : 'Evaluated',
    result.aiProvider,
    result.modelId,
    new Date().toISOString(),
    'AI Scored'
  );

  // Check if team already has a row (Idempotency)
  let existingRowIndex = -1;
  let existingManualScore: string | number = '';
  let existingReviewerComments: string | number = '';

  for (let r = 1; r < rows.length; r++) {
    if (rows[r] && String(rows[r][0]).trim() === result.teamId) {
      existingRowIndex = r + 1; // 1-based index in sheets
      // Preserve existing manual scores and comments if present
      const manualScoreColIdx = expectedHeaders.indexOf('Human-Adjusted Score');
      const commentsColIdx = expectedHeaders.indexOf('Reviewer Comments');
      if (manualScoreColIdx !== -1 && rows[r][manualScoreColIdx] !== undefined) {
        existingManualScore = rows[r][manualScoreColIdx];
      }
      if (commentsColIdx !== -1 && rows[r][commentsColIdx] !== undefined) {
        existingReviewerComments = rows[r][commentsColIdx];
      }
      break;
    }
  }

  // Append preserved manual score and comments
  rowValues.push(existingManualScore);
  rowValues.push(existingReviewerComments);

  if (existingRowIndex !== -1) {
    // Update existing row
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${existingRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [rowValues],
      },
    });
    return { rowIndex: existingRowIndex, action: 'updated' };
  } else {
    // Append new row
    const appendResponse = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [rowValues],
      },
    });

    const updatedRange = appendResponse.data.updates?.updatedRange || '';
    const match = updatedRange.match(/!A(\d+):/);
    const newRowIndex = match ? parseInt(match[1], 10) : rows.length + 1;

    return { rowIndex: newRowIndex, action: 'appended' };
  }
}

export async function updateMasterSheetStatus(
  spreadsheetId: string,
  teamId: string,
  status: string,
  timestamp: string,
  sheetTabName: string = 'Master_Submissions'
): Promise<void> {
  try {
    const { auth } = getGoogleAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetTabName}!A1:ZZ500`,
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) return;

    const headers = rows[0].map((h) => String(h).trim().toLowerCase());
    const teamIdIdx = headers.indexOf('team id');
    let statusColIdx = headers.indexOf('ai evaluation status');
    let timeColIdx = headers.indexOf('evaluation timestamp');

    if (teamIdIdx === -1) return;

    // Find row
    let targetRowIndex = -1;
    for (let r = 1; r < rows.length; r++) {
      if (rows[r] && String(rows[r][teamIdIdx]).trim() === teamId) {
        targetRowIndex = r + 1;
        break;
      }
    }

    if (targetRowIndex === -1) return;

    if (statusColIdx !== -1) {
      const colLetter = String.fromCharCode(65 + statusColIdx);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetTabName}!${colLetter}${targetRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[status]] },
      });
    }

    if (timeColIdx !== -1) {
      const colLetter = String.fromCharCode(65 + timeColIdx);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetTabName}!${colLetter}${targetRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[timestamp]] },
      });
    }
  } catch (err) {
    console.warn('Could not update status back to master sheet:', err);
  }
}
