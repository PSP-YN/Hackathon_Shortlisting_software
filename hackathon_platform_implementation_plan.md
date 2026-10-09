# Architecture Blueprint & Implementation Plan
## Cloud-Based AI Hackathon Evaluation Platform

### 1. Executive Summary & Architecture Overview
The platform transitions hackathon evaluation from local Excel scripts to a resilient, cloud-native web application deployed on Vercel and backed by Supabase (PostgreSQL, Auth, RLS) and Google Cloud (Gemini API, Google Sheets API, Google Drive API).

```
   ┌────────────────────────────────────────────────────────┐
   │                  Next.js App Router                    │
   │  (Vercel Hosted: Dashboard, Forms, Realtime Monitor)   │
   └───────────┬────────────────────────────────┬───────────┘
               │                                │
      Supabase Auth & RLS              Server Actions & API Routes
               │                                │
   ┌───────────▼───────────┐      ┌─────────────▼──────────────┐
   │    PostgreSQL DB      │      │     Durable Job Worker     │
   │ - Profiles & Roles    │◄─────┤   (Database Job Leasing)   │
   │ - Domain Mappings     │      └─────────────┬──────────────┘
   │ - Evaluation Jobs     │                    │
   │ - Review Records      │         ┌──────────┼──────────┐
   │ - Audit Logs          │         │          │          │
   └───────────────────────┘         ▼          ▼          ▼
                             Google Sheets Google Drive Google Gemini
                              (Submissions   (Slides &   (Structured
                               & Results)      PDFs)      Evaluation)
```

---

### 2. Core Architecture Components

#### A. Authentication & Role-Based Access Control (RBAC)
- **Supabase Auth** with secure session cookies (`@supabase/ssr`).
- **User Roles**:
  - `super_admin`: Full system control, Google Sheets connection, domain setup, evaluator management, job controls, audit logs.
  - `domain_evaluator`: Access restricted exclusively to assigned domains. Manual scoring, comments, submit final reviews.
  - `read_only_observer`: Read-only access to authorized domain results.
- **Enforcement**: Database Row Level Security (RLS) + Next.js server-side layout/route handlers (`requireRole`, `requireDomainAccess`).

#### B. Database Schema (PostgreSQL via Supabase Migrations)
1. `profiles`: `id (uuid, FK auth.users)`, `email`, `role`, `assigned_domains (text[])`, `created_at`
2. `system_settings`: Key-value configuration for active Spreadsheet ID, scoring mode (`direct_points` vs `weighted`), final score policy (`ai_provisional`, `human_reviewed`, `admin_approved`).
3. `domain_configs`: Domain name, criteria list (with IDs, weights, max points, instructions, evidence requirements).
4. `sheet_column_mappings`: Configurable mapping between Master_Submissions column headers and standardized fields (`team_id`, `team_name`, `domain`, `project_title`, `description`, `presentation_url`, `repo_url`, etc.).
5. `evaluation_jobs`: Durable queue table:
   - `id (uuid)`, `team_id`, `domain`, `status` (`pending`, `queued`, `fetching_submission`, `extracting_content`, `evaluating_gemini`, `validating_scores`, `writing_sheets`, `completed`, `needs_human_review`, `failed`, `cancelled`)
   - `idempotency_key`, `attempts`, `max_attempts`, `locked_at`, `locked_by`, `error_message`, `stage_details`, `created_at`, `updated_at`
6. `evaluation_results`: Store AI evaluation results:
   - `job_id`, `team_id`, `domain`, `ai_provider` (`gemini`), `model_id`, `criterion_scores (jsonb)`, `calculated_total`, `max_total`, `feedback_summary`, `strengths`, `weaknesses`, `risks`, `missing_evidence`, `flags`
7. `manual_reviews`: Human review adjustments:
   - `team_id`, `evaluator_id`, `criterion_scores (jsonb)`, `total_score`, `comments`, `status` (`draft`, `submitted`, `approved`, `returned`), `created_at`, `updated_at`
8. `audit_logs`: Immutable action trail (`user_id`, `action`, `resource_type`, `resource_id`, `metadata`, `ip_address`, `timestamp`).

#### C. Google Sheets & Google Drive Integration
- Dedicated **Google Service Account** with credentials stored in server-only environment variables (`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_PROJECT_ID`).
- **Sheets API (`googleapis`)**:
  - `Master_Submissions` parser using dynamic column mapping.
  - Auto-initialization of the 5 domain sheets (`Domain_1` to `Domain_5` or mapped domain names) with dynamic criterion headers.
  - Idempotent upsert of results to prevent duplicate rows.
  - Preserves any manual score columns and existing rows.
- **Drive API & Document Extraction**:
  - Validates presentation URLs (Google Drive / Google Slides / PDF / PPTX links).
  - Resolves Google Drive file permissions securely using authorized service account.
  - Slide text extraction:
    - Google Slides: Drive API export to plain text or Google Slides API structured slide parsing.
    - PDF submissions: Node.js stream extraction via `pdf-parse`.
    - PPTX submissions: Extracted via `jszip` + XML slide text extraction.
  - Fallback reporting: Clear error states if permissions are missing or format is unreadable.

#### D. Gemini AI Evaluation Engine (`@google/genai`)
- **AI Provider Abstraction** (`AiEvaluationProvider` interface) to decouple Gemini from the evaluation pipeline, enabling seamless future addition of Claude.
- **Strict Zod Output Validation**:
  - Criterion level: `{ criterion_id, score, max_score, justification, slide_or_page_ref, confidence }`
  - Overall level: `{ summary, strengths, weaknesses, missing_evidence, technical_risks, clarification_flags, needs_human_review }`
- **Security & Prompt Defense**:
  - Treat all presentation content strictly as untrusted text.
  - Defend against prompt injection (ignore instructions in slides attempting to modify scoring rubric or assign bonus points).
- **Deterministic Math**: Backend calculates the authoritative final score (either direct sum or weighted calculation). Gemini never computes or overrides final totals.
- **Configurable Model & Resilience**:
  - Server env `GEMINI_MODEL` (default: `gemini-2.5-flash` or `gemini-1.5-pro`).
  - Exponential backoff with jitter for rate limits (429) and transient errors.

#### E. Durable Evaluation Queue
- Database-backed job leasing:
  - Jobs are fetched with atomic lock (`locked_at = now()`, `locked_by = worker_id`).
  - Idempotency key per `team_id` + `evaluation_version`.
  - Step-by-step progress tracking persisted to database and broadcast to dashboard.
  - Action controls: Evaluate One, Evaluate All, Evaluate Selected, Retry Failed, Pause Queue, Cancel Job.

#### F. Manual Evaluation & Human Review Module
- Side-by-side submission inspector (AI findings vs presentation link vs manual score inputs).
- Live validation against criterion maximums.
- Draft vs Submitted vs Approved states.
- Configurable final score policy:
  - `ai_provisional` (AI score is default until reviewed)
  - `human_reviewed` (Requires evaluator submission)
  - `admin_approved` (Requires super admin sign-off)

---

### 3. Implementation Phases

| Phase | Milestone | Deliverables |
|---|---|---|
| **Phase 1** | Project Setup & Packages | Install `@supabase/supabase-js`, `@supabase/ssr`, `googleapis`, `@google/genai`, `zod`, `lucide-react`, `pdf-parse`, `jszip`, `vitest`. Configure Tailwind & path aliases. |
| **Phase 2** | Supabase Auth, RBAC & Database Schema | SQL migrations for all tables, RLS policies, role helpers, session middleware, authentication pages (Login, Setup). |
| **Phase 3** | Google Sheets & Drive Integration | Service account client, column mapper, sheet reader, domain sheet generator, Drive text extractor (Slides, PDF, PPTX). |
| **Phase 4** | Gemini AI Engine & Rubric Evaluator | Provider abstraction, system prompt with injection defenses, Zod schemas, deterministic scoring logic (direct & weighted). |
| **Phase 5** | Queue Worker & Realtime Dashboard | Durable job leasing, status pipeline, dashboard overview stats, live queue table, batch evaluation actions. |
| **Phase 6** | Manual Review & Audit Logging | Review UI, score override modal, audit log persistence, final score policy resolver. |
| **Phase 7** | Automated Testing & Dry-Run Mode | Vitest suite for RBAC, scoring, Zod validation, Drive errors, prompt injection handling, and dry-run flag. |
| **Phase 8** | Cloud Deployment Documentation | Vercel deployment config, `.env.example`, Supabase setup guide, Google Cloud setup guide, Gemini setup guide, post-deployment checklist. |
| **Phase 9** | End-to-End Verification & Reporting | Run end-to-end dry-run and test suite, verify clean build, finalize audit report. |
