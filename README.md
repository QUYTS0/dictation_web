# DictaLearn — English Dictation Trainer

Paste a YouTube link, and DictaLearn turns it into a sentence-by-sentence dictation
exercise: the video auto-pauses after each sentence, you type what you heard, and it's
checked against the transcript. Wrong answers get a hint ladder and optional AI (Gemini)
grammar explanations. Signed-in users get autosave/resume, mistake history, a saved
vocabulary list, and a practice dashboard.

See [`Master Plan.md`](./Master%20Plan.md) for the full product spec, data model, and
roadmap.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS · Zustand · TanStack Query ·
Supabase (Postgres + Auth) · Google Gemini

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.local.example` to `.env.local` and fill in your Supabase project
   credentials (Settings → API) and a [Gemini API key](https://aistudio.google.com/app/apikey):

   ```bash
   cp .env.local.example .env.local
   ```

3. Apply the database schema. In the Supabase SQL editor (or via the CLI), run the
   migrations in order:

   - `supabase/migrations/001_initial.sql`
   - `supabase/migrations/002_auth_features.sql`

4. Run the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm test` — Jest unit tests

CI (`.github/workflows/ci.yml`) runs lint, tests, and build on every push/PR to `main`.

## Deploying

Targets Vercel. Set the same environment variables from `.env.local.example` in your
Vercel project settings before deploying.
