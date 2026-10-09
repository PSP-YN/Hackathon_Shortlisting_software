-- ====================================================================
-- HACKATHON EVALUATION PLATFORM: INITIAL DATABASE SCHEMA
-- Migration: 001_initial_schema.sql
-- ====================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. User Roles Enum
CREATE TYPE user_role AS ENUM (
  'super_admin',
  'domain_evaluator',
  'read_only_observer'
);

-- 3. Job Status Enum
CREATE TYPE job_status AS ENUM (
  'pending',
  'queued',
  'fetching_submission',
  'extracting_content',
  'evaluating_gemini',
  'validating_scores',
  'writing_sheets',
  'completed',
  'needs_human_review',
  'failed',
  'cancelled'
);

-- 4. Review Status Enum
CREATE TYPE review_status AS ENUM (
  'draft',
  'submitted',
  'approved',
  'returned'
);

-- 5. User Profiles (Linked to auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT,
  role user_role NOT NULL DEFAULT 'read_only_observer',
  assigned_domains TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. System Settings (Persistent Key-Value Store for Global Config)
CREATE TABLE IF NOT EXISTS public.system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_by UUID REFERENCES public.profiles(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Domain Configurations & Criteria Rubrics
CREATE TABLE IF NOT EXISTS public.domain_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain_key TEXT NOT NULL UNIQUE, -- e.g. "Domain_1" or "FinTech"
  display_name TEXT NOT NULL,
  sheet_name TEXT NOT NULL, -- Spreadsheet tab name
  spreadsheet_id TEXT, -- Optional dedicated spreadsheet ID for complete physical domain isolation
  scoring_mode TEXT NOT NULL DEFAULT 'direct_points' CHECK (scoring_mode IN ('direct_points', 'weighted')),
  total_max_score NUMERIC(6, 2) NOT NULL DEFAULT 100.00,
  criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Sheet Column Mappings
CREATE TABLE IF NOT EXISTS public.sheet_column_mappings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  field_name TEXT NOT NULL UNIQUE, -- Standard field name
  sheet_header TEXT NOT NULL, -- Column title in Master_Submissions
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Submissions (Cached from Master_Submissions)
CREATE TABLE IF NOT EXISTS public.submissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id TEXT NOT NULL UNIQUE,
  team_name TEXT NOT NULL,
  domain TEXT NOT NULL,
  project_title TEXT NOT NULL,
  project_description TEXT,
  problem_statement TEXT,
  presentation_url TEXT,
  repo_url TEXT,
  submission_status TEXT DEFAULT 'submitted',
  raw_data JSONB DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. Durable Evaluation Jobs Queue
CREATE TABLE IF NOT EXISTS public.evaluation_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id TEXT NOT NULL REFERENCES public.submissions(team_id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  status job_status NOT NULL DEFAULT 'pending',
  current_stage TEXT NOT NULL DEFAULT 'Job Created',
  progress_pct INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  evaluation_version INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  error_message TEXT,
  error_details JSONB,
  is_dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. AI Evaluation Results
CREATE TABLE IF NOT EXISTS public.evaluation_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID REFERENCES public.evaluation_jobs(id) ON DELETE SET NULL,
  team_id TEXT NOT NULL REFERENCES public.submissions(team_id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  ai_provider TEXT NOT NULL DEFAULT 'gemini',
  model_id TEXT NOT NULL,
  scoring_mode TEXT NOT NULL CHECK (scoring_mode IN ('direct_points', 'weighted')),
  criterion_scores JSONB NOT NULL,
  calculated_total NUMERIC(6, 2) NOT NULL,
  max_possible_score NUMERIC(6, 2) NOT NULL,
  feedback_summary TEXT,
  strengths TEXT[] DEFAULT '{}',
  weaknesses TEXT[] DEFAULT '{}',
  missing_evidence TEXT[] DEFAULT '{}',
  technical_risks TEXT[] DEFAULT '{}',
  clarification_flags TEXT[] DEFAULT '{}',
  needs_human_review BOOLEAN NOT NULL DEFAULT FALSE,
  extracted_content_summary TEXT,
  written_to_sheet_at TIMESTAMPTZ,
  sheet_row_index INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_team_version UNIQUE (team_id, job_id)
);

-- 12. Manual Human Reviews
CREATE TABLE IF NOT EXISTS public.manual_reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id TEXT NOT NULL REFERENCES public.submissions(team_id) ON DELETE CASCADE,
  evaluator_id UUID NOT NULL REFERENCES public.profiles(id),
  ai_result_id UUID REFERENCES public.evaluation_results(id),
  criterion_scores JSONB NOT NULL,
  total_score NUMERIC(6, 2) NOT NULL,
  comments TEXT,
  status review_status NOT NULL DEFAULT 'draft',
  approved_by UUID REFERENCES public.profiles(id),
  approved_at TIMESTAMPTZ,
  written_to_sheet_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_team_manual_review UNIQUE (team_id, evaluator_id)
);

-- 13. Audit Logs (Immutable Log of System Actions)
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_submissions_domain ON public.submissions(domain);
CREATE INDEX IF NOT EXISTS idx_evaluation_jobs_status ON public.evaluation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_evaluation_jobs_team ON public.evaluation_jobs(team_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_jobs_locked ON public.evaluation_jobs(locked_at) WHERE locked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evaluation_results_team ON public.evaluation_results(team_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_results_domain ON public.evaluation_results(domain);
CREATE INDEX IF NOT EXISTS idx_manual_reviews_team ON public.manual_reviews(team_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs(created_at DESC);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sheet_column_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evaluation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evaluation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manual_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Helper functions
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS user_role AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'super_admin'
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.has_domain_access(domain_name TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
    AND (
      role = 'super_admin'
      OR (role = 'domain_evaluator' AND domain_name = ANY(assigned_domains))
      OR (role = 'read_only_observer' AND domain_name = ANY(assigned_domains))
    )
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- Policies
CREATE POLICY profiles_select_self_or_admin ON public.profiles
  FOR SELECT USING (auth.uid() = id OR public.is_super_admin());

CREATE POLICY profiles_update_admin_only ON public.profiles
  FOR UPDATE USING (public.is_super_admin());

CREATE POLICY profiles_insert_admin_only ON public.profiles
  FOR INSERT WITH CHECK (public.is_super_admin() OR auth.uid() = id);

CREATE POLICY settings_admin_all ON public.system_settings
  FOR ALL USING (public.is_super_admin());

CREATE POLICY domain_configs_read ON public.domain_configs
  FOR SELECT USING (
    public.is_super_admin()
    OR public.has_domain_access(domain_key)
    OR public.has_domain_access(display_name)
  );

CREATE POLICY domain_configs_admin_write ON public.domain_configs
  FOR ALL USING (public.is_super_admin());

CREATE POLICY mappings_read ON public.sheet_column_mappings
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY mappings_admin_write ON public.sheet_column_mappings
  FOR ALL USING (public.is_super_admin());

CREATE POLICY submissions_read ON public.submissions
  FOR SELECT USING (public.has_domain_access(domain));

CREATE POLICY submissions_admin_write ON public.submissions
  FOR ALL USING (public.is_super_admin());

CREATE POLICY jobs_read ON public.evaluation_jobs
  FOR SELECT USING (public.has_domain_access(domain));

CREATE POLICY jobs_admin_write ON public.evaluation_jobs
  FOR ALL USING (public.is_super_admin());

CREATE POLICY results_read ON public.evaluation_results
  FOR SELECT USING (public.has_domain_access(domain));

CREATE POLICY results_admin_write ON public.evaluation_results
  FOR ALL USING (public.is_super_admin());

CREATE POLICY reviews_read ON public.manual_reviews
  FOR SELECT USING (
    public.is_super_admin()
    OR evaluator_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.submissions s
      WHERE s.team_id = manual_reviews.team_id AND public.has_domain_access(s.domain)
    )
  );

CREATE POLICY reviews_write ON public.manual_reviews
  FOR ALL USING (
    public.is_super_admin()
    OR (
      evaluator_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.submissions s
        WHERE s.team_id = manual_reviews.team_id AND public.has_domain_access(s.domain)
      )
    )
  );

CREATE POLICY audit_logs_read ON public.audit_logs
  FOR SELECT USING (public.is_super_admin());

-- Seed default column mappings
INSERT INTO public.sheet_column_mappings (field_name, sheet_header, is_required, description)
VALUES
  ('team_id', 'Team ID', TRUE, 'Unique team identifier'),
  ('team_name', 'Team Name', TRUE, 'Official team name'),
  ('domain', 'Domain', TRUE, 'Domain category or track'),
  ('project_title', 'Project Title', TRUE, 'Name of the project or solution'),
  ('project_description', 'Project Description', FALSE, 'Detailed overview of the solution'),
  ('problem_statement', 'Problem Statement', FALSE, 'Challenge or problem tackled'),
  ('presentation_url', 'Presentation URL', TRUE, 'Google Drive / Slides / PDF link'),
  ('repo_url', 'GitHub Repository URL', FALSE, 'Optional code repository link'),
  ('submission_status', 'Submission Status', FALSE, 'Status in master submission sheet'),
  ('ai_evaluation_status', 'AI Evaluation Status', FALSE, 'AI status column in master sheet'),
  ('evaluation_timestamp', 'Evaluation Timestamp', FALSE, 'Time of AI evaluation')
ON CONFLICT (field_name) DO NOTHING;

-- Seed default settings
INSERT INTO public.system_settings (key, value, description)
VALUES
  ('spreadsheet_id', '""'::jsonb, 'Active Google Spreadsheet ID'),
  ('scoring_mode', '"direct_points"'::jsonb, 'Scoring mode: direct_points or weighted'),
  ('final_score_policy', '"human_reviewed"'::jsonb, 'Policy: ai_provisional, human_reviewed, or admin_approved'),
  ('gemini_model', '"gemini-2.5-flash"'::jsonb, 'Active Google Gemini model identifier'),
  ('concurrency_limit', '3'::jsonb, 'Maximum parallel AI evaluation jobs'),
  ('dry_run_mode', 'false'::jsonb, 'Enable dry-run mode to avoid writing to official sheets')
ON CONFLICT (key) DO NOTHING;
