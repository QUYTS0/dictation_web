# Dashboard redesign runbook — migrations 046+

**Status:** `046`, `047` and `048` implemented and verified locally (route/component tests and real
PostgreSQL on a disposable local server). Whether each is applied to the Supabase project is not
tracked here: check with `npx supabase migration list`. Apply them in order, each **before** the
app version that needs it: `046`, `047`, then `048`.
Plan: `.claude/dashboard-redesign-plan.md`. Later phases (`049` achievements, `050` leagues) add
their own sections here.

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

## 047 — Profile preferences and active time per local day (Phase 4)

### What ships

| Area | What the learner gets | Source |
|---|---|---|
| Weekly consistency track | Mon–Sun of the viewer's local week in the hero: ✓ on days with any practice (the streak's own day set, word reviews included), the ember on today, active minutes under each day, and a details popover (date · minutes · Active) on practiced days. | `GET /api/dashboard/week` → `fn_activity_days` + `fn_daily_activity` |
| Today's target | Today's active minutes against the daily goal, teal with "Goal met today ✓" once reached. | same route |
| 7-day bars | The last 7 local days of active time under "Est. active practice". | same route |
| Daily goal | 10 / 15 / 20 / 30 / 45 / 60 min, saved to the account (default 15). Set in **Profile & preferences** (account menu, or the slider icon next to Today's target). | `users.daily_goal_minutes`, `GET/PATCH /api/profile` |
| Phase 7 groundwork | `users.public_name`, `users.leaderboard_hidden` and the generated nickname exist but nothing shows them yet. | `fn_my_profile`, `fn_update_my_profile` |

Minutes per day use the same rule as "Est. active practice" (the union of engaged intervals, two
tabs counted once), cut at each local midnight, so the days of a range add up to that total. A
day with only word reviews gets its ✓ but 0 minutes: reviews aren't timed.

### Deploy order

1. **Apply `047`** (after `046`). It is idempotent; re-running it keeps every saved preference.
2. **Then deploy the app.** If the app is deployed first, `/api/dashboard/week` and `/api/profile`
   answer `503 learning_data_unavailable`: the hero leaves out the track and Today's target, the
   7-day bars are left out, and Profile & preferences says it isn't available. Nothing else is
   affected.

### Verify after applying

```sql
-- The three columns and their checks:
select column_name, data_type, is_nullable, column_default from information_schema.columns
 where table_name = 'users' and column_name in ('daily_goal_minutes', 'public_name', 'leaderboard_hidden');
select conname from pg_constraint where conrelid = 'users'::regclass and conname like 'users_%_check';
-- users_daily_goal_minutes_check, users_public_name_check

-- Grants: authenticated may execute the three reads/writes; the nickname helper is internal.
select has_function_privilege('authenticated', 'fn_my_profile()', 'execute');                       -- true
select has_function_privilege('authenticated', 'fn_update_my_profile(jsonb)', 'execute');          -- true
select has_function_privilege('authenticated', 'fn_daily_activity(text,date,date)', 'execute');    -- true
select has_function_privilege('anon',          'fn_daily_activity(text,date,date)', 'execute');    -- false
select has_function_privilege('authenticated', 'fn_public_nickname(uuid)', 'execute');             -- false
```

Then open the Dashboard: the hero shows the weekly track and Today's target. Change the goal in
Profile & preferences and check it stuck:
`select daily_goal_minutes from users where id = '<your user id>';`

### Rollback

Deploy the previous app version first, then
`drop function fn_daily_activity(text, date, date); drop function fn_update_my_profile(jsonb); drop function fn_my_profile(); drop function fn_public_nickname(uuid);`.
Keep the columns: dropping them loses saved goals, and later phases (leagues) read the other two.

### Local verification

Same server as 046, then:

```
LOCALDB_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres npx jest src/__tests__/integration/profile-daily-activity
```

## 048 — XP and levels, calculated (Phase 5)

### What ships

| Area | What the learner gets | Source |
|---|---|---|
| XP | A total calculated from the practice already recorded — existing learners get XP for their past practice. Nothing is stored or awarded. | `fn_my_xp` → `GET /api/xp` |
| Levels | "Level N": level L starts at 50·L·(L−1) XP (2 at 100, 5 at 1,000, 10 at 4,500). Derived in the app from the total. | `src/lib/xp/levels.ts` |
| Header | "4,850 XP · Lvl 10" pill (from `lg` widths). | same route |
| Hero | Level bar; XP under each day of the weekly track; full day details (time, Dictation and Shadowing sentences, words reviewed, XP). | same route |
| Celebrations | Confetti + toast on the first Dashboard visit after the daily goal is met or a level is gained, once per browser (toast only under reduced motion). | localStorage |
| Monday recap | "Last week: 1,240 XP · 96 min · 41 words reviewed" above the hero, on the first visit of a league week (Monday 00:00 UTC), dismissible. | same route |

Rules v1 (each pays its **first** occurrence only): +10 first valid Dictation answer per sentence and
round, +5 first correct one; +10 first valid Shadowing take per sentence and round, +5 first with
Azure pronunciation ≥ 80; +1 per whole minute of newly covered Listening per study session; +3 first
review of a word per local day (max 60 XP a day); +50 verified round completion; +10 per active
local day. The daily goal earns nothing. The local-day rules use the learner's most recently
recorded browser timezone (UTC if none), so a total is the same in every view.

### Expected side effects

- **Every existing learner gets XP at once**, calculated from their history — expected and truthful.
- **Totals can move a little** when practice records change (a deleted round, a re-evaluated
  Shadowing take) or when a learner starts practicing in a new timezone (the day-based rules
  re-date). A rules change would also rewrite totals; bump `rulesVersion` and announce it.
- **Read cost:** each `/api/xp` call recomputes the learner's whole history (the header asks on
  every signed-in page, cached for a minute). Fine at the current scale; see plan §7.

### Deploy order

1. **Apply `048`** (after `047`). Reads only, no table changes; re-running it is harmless.
2. **Then deploy the app.** If the app is deployed first, `/api/xp` answers
   `503 learning_data_unavailable`: the XP pill, level bar, per-day XP, level-up celebrations and
   the Monday recap are left out, and the weekly track shows minutes as in Phase 4. Goal-met
   celebrations still work. Nothing else is affected.

### Verify after applying

```sql
select has_function_privilege('authenticated', 'fn_my_xp(text)', 'execute');                         -- true
select has_function_privilege('anon',          'fn_my_xp(text)', 'execute');                         -- false
select has_function_privilege('authenticated', 'fn_xp_events(uuid,text)', 'execute');                 -- false
select has_function_privilege('authenticated', 'fn_xp_time_zone(uuid)', 'execute');                   -- false
select has_function_privilege('authenticated', 'fn_active_seconds_between(uuid,timestamptz,timestamptz)', 'execute'); -- false

-- One learner's events by source (SQL editor runs as the owner):
select source, count(*), sum(amount) from fn_xp_events('<user id>', fn_xp_time_zone('<user id>')) group by source order by source;
```

Then open the Dashboard: the header pill and the hero's level bar show the same total.

### Rollback

Deploy the previous app version first, then
`drop function fn_my_xp(text); drop function fn_xp_events(uuid, text); drop function fn_xp_time_zone(uuid); drop function fn_active_seconds_between(uuid, timestamptz, timestamptz);`.
Nothing is lost: XP is never stored.

### Local verification

Same server as 046, then:

```
LOCALDB_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres npx jest src/__tests__/integration/xp-levels
```
