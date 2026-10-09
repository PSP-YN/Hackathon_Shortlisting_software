# Cloud-Based AI Hackathon Evaluation Platform

A production-grade, cloud-deployed platform to evaluate hackathon submissions using Google Gemini, structured scoring rubrics, and Google Sheets synchronization.

## Architecture & Tech Stack
- **Frontend & Backend**: Next.js (App Router), React, Tailwind CSS, TypeScript
- **Database & Auth**: Supabase (PostgreSQL, Row Level Security, GitHub/Email Auth)
- **AI Engine**: Google Gemini API (gemini-2.5-flash) via `@google/genai`
- **Integrations**: Google Sheets API (for scores) & Google Drive API (for presentations)
- **Deployment**: Vercel (Web app & Serverless Functions) & Vercel Cron (Job Queue)

## Features
- **Job Queue**: Reliable evaluation queue with row-level locks to prevent double-processing.
- **Idempotency**: Results are synced robustly to Google Sheets, handling network drops.
- **AI Scoring Engine**: Enforces strict rubric boundaries (max points, clamping) and outputs structured rationale via Zod schemas.
- **RBAC**: Domain-based isolation. Evaluators can only see their assigned domains, and Super Admins manage everything.
- **Security**: Hardened against prompt-injections, protects raw credentials, ensures end-to-end type safety, and uses RLS policies.

## Local Setup

1. **Install Dependencies**
   ```bash
   npm install --legacy-peer-deps
   ```

2. **Environment Variables**
   Copy `.env.example` to `.env.local` and fill in the necessary keys.
   *Important*: Ensure `GOOGLE_PRIVATE_KEY` has standard literal `\n` line breaks when pasting.

3. **Supabase Initialization**
   Run the SQL script located in `supabase/migrations/001_initial_schema.sql` inside your Supabase project's SQL editor.

4. **Run Locally**
   ```bash
   npm run dev
   ```

## Automated Testing

Testing covers RBAC, prompt-injection defense, AI evaluation constraints, and Zod output schemas.

```bash
npm run test
```

## Cloud Deployment (Vercel)

1. Connect your GitHub repository to Vercel.
2. In the Vercel dashboard, under **Settings > Environment Variables**, add all the variables from your `.env.local`. 
3. *Google Private Key Issue*: Ensure the `GOOGLE_PRIVATE_KEY` uses actual literal line breaks or is parsed properly (it might require enclosing in quotes depending on UI).
4. **Vercel Cron**: The project includes a `vercel.json` file configuring a background cron job that hits `/api/queue/process` every minute to consume pending AI evaluation tasks.
5. Hit **Deploy**. 

## Usage
- Submissions trigger a background job on the `evaluation_jobs` table.
- The cron hits `/api/queue/process`.
- The system leases jobs securely, parses the Drive link, prompts Gemini with the rubric, calculates the definitive score, inserts it into Supabase, and publishes back to Google Sheets.

## Security Considerations
- Do not commit `.env.local`!
- Do not give `SUPABASE_SERVICE_ROLE_KEY` to the client side.
- Prompt injection attempts will be logged to `clarificationFlags` and push the evaluation into a `needsHumanReview` state.
