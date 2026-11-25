# Dashboard redesign runbook — migrations 046+

**Status:** `046` implemented and verified locally (route/component tests and real PostgreSQL on a
disposable local server). **Nothing here is applied to the Supabase project or deployed.**
Plan: `.claude/dashboard-redesign-plan.md`. Later phases (`047` profile + daily activity, `048` XP,
`049` achievements, `050` leagues) add their own sections here.

## 046 — Vocabulary review log; reviews count toward the streak (Phase 3)

### What ships

| Area | What the learner gets | Source |
|---|---|---|
| Review log | Every graded review is recorded (grade, time, the browser's timezone). | `vocabulary_reviews`, `fn_record_vocabulary_review` |
| Streak | A day with only vocabulary review now counts as a practice day — in the header pill, the footer, the Dashboard and the practice page alike. | `fn_activity_days` (rule 4) |
| History of past reviews | Each word already reviewed before 046 contributes one backfilled review at its last review date (grade unknown, UTC day). Older reviews were never recorded and stay unknown. | backfill in `046` |
| Dashboard review deck | Grades on the Dashboard and on `/vocabulary/review` both go through the one write function. | `POST /api/vocabulary/review` |

### Deploy order

1. **Apply `046` first** (Supabase SQL editor or `supabase db push`). It is idempotent; re-running it
   adds nothing.
2. **Then deploy the app.** If the app is deployed first, grading a review answers
   `503 {"code":"learning_data_unavailable"}` ("This feature is not available yet.") until `046` is
   applied — nothing is lost or corrupted, but reviews can't be saved in that window.

### Verify after applying

```sql
-- One backfilled row per already-reviewed word, and nothing else yet:
select backfilled, count(*) from vocabulary_reviews group by backfilled;
select count(*) from vocabulary_items where last_reviewed_at is not null;   -- should equal the backfilled count

-- Grants: authenticated may only SELECT the log and EXECUTE the write function.
select grantee, privilege_type from information_schema.role_table_grants where table_name = 'vocabulary_reviews';
select has_function_privilege('authenticated', 'fn_record_vocabulary_review(uuid,text,numeric,numeric,integer,timestamptz,text)', 'execute'); -- true
select has_function_privilege('anon',          'fn_record_vocabulary_review(uuid,text,numeric,numeric,integer,timestamptz,text)', 'execute'); -- false
```

Then grade one card on `/vocabulary/review` and check a new row with a grade and your timezone:
`select grade, client_timezone, backfilled from vocabulary_reviews order by reviewed_at desc limit 1;`

### Expected side effect

Some learners' **current streak may grow** right after `046`: days when they only reviewed words now
count (but only the last review per word is known from before `046`). This is truthful.

### Rollback

`046` only adds a table, a function and a new body for `fn_activity_days`. To undo: deploy the
previous app version first (its review route writes `vocabulary_items` directly), then re-run the
`fn_activity_days` definition from `040` and `drop function fn_record_vocabulary_review(...)`. Keep
`vocabulary_reviews` — dropping it loses review history that later phases (XP) read.

### Local verification

```
npm install --no-save embedded-postgres@17.9.0-beta.17
node scripts/localdb/start-embedded-postgres.mjs
LOCALDB_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres npx jest src/__tests__/integration/vocabulary-review-log
```
