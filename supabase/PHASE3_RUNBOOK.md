# Phase 3 runbook — authoritative Dictation/round writes, provenance backfill, legacy retirement

**Status:** implemented and rehearsed on a disposable local PostgreSQL 17
server. **Nothing here has been applied to the Supabase project or deployed.**
Migrations `001`–`036` are applied to the project (per the user); `037` is not.

Operator SQL lives in `supabase/phase3/` (outside `migrations/`, so
`supabase db push` never runs it). Every state-changing step is an explicit,
owner-only function call; each script below is the exact file that the
automated rehearsal executed.

---

## 1. Migration numbering

| Number | File | What `db push` does |
|---|---|---|
| `037` | `037_phase3_prepare_authoritative_cutover.sql` | **Preparation only.** Installs the corrected authoritative functions (dormant: no app-role EXECUTE, and they refuse to write until activated), grading-parity SQL, `fn_persist_session_assessment` (backend-only, granted to `service_role` now), `fn_practice_write_status`, cutover state/audit tables, and the owner-only stage functions. It pauses nothing, backfills nothing, retires nothing, and leaves `learning_sessions` RLS untouched. |
| `038` | `038_fn_delete_transcript_revision.sql` | Unchanged future plan (Script Versions) — **not created**. |

The plan's earlier "`037` = provenance backfill and completion cutover" is now
`037` = preparation + the backfill/cutover *functions*; the backfill and
activation themselves run from the operator scripts, not from a migration.

`037` requires the ICU collation `und-x-icu` (present on Supabase); it fails
fast with a clear message if the server lacks it.

## 2. Writer inventory

| Writer | Identity | Mutable fields | Before (Phase 2) | After Phase 3 | Authorization | Cutover protection |
|---|---|---|---|---|---|---|
| `POST /api/session/save-progress` | caller's JWT (`authenticated`) | checkpoint; first touch creates the round | `fn_legacy_save_progress` (client-trusted status/accuracy/counters) | `fn_update_resume_position` / `fn_create_or_get_active_round` — checkpoint only; status/counters/completion ignored | `auth.uid()` + owner/video/pin checks in SQL | gate FOR SHARE in both paths; bridge also checks `legacy_writes_retired` |
| `POST /api/session/restart` | caller's JWT | abandon + next round | `fn_legacy_restart_round` (abandon only) | `fn_restart_round` (abandon, close study session, create next round — one transaction, retry-safe) | same | same |
| `POST /api/dictation/check` | Phase 2: service role after route ownership check; Phase 3: caller's JWT | attempt row; completion; counters | `fn_legacy_record_dictation_attempt` (client-computed correctness) | `fn_record_dictation_attempt` (server resolves the reference text and grades it; idempotent) | `auth.uid()` + round/video/pin/segment/study-session checks in SQL | same |
| `POST /api/session/[id]/explain-all` | caller's JWT, direct `UPDATE learning_sessions` | `ai_assessment`, `ai_assessment_generated_at` | direct table write (RLS `sessions_owner`) | `fn_persist_session_assessment` via service client after the route's ownership check — only those two fields | route ownership check + `(id, user_id)` re-check in SQL; `service_role` only | none needed: not lifecycle data |
| Direct PostgREST writes to `learning_sessions` | `authenticated`/`anon` | anything | open (`sessions_owner`, `sessions_anon_insert`) | **closed** (owner SELECT only; no INSERT/UPDATE/DELETE grants for any app role) | — | step 2 |
| Direct `attempt_logs` INSERT by `service_role` | service key | attempt rows | granted (031) | **revoked** | — | step 2 |
| Shadowing attempts (`fn_record_shadowing_attempt`) | caller's JWT | attempt row; completion | dormant | granted at activation (no route calls it until Phase 4) | same checks as Dictation | gate |

No other writer of `learning_sessions` / `attempt_logs` exists in `src/`
(guarded by a test that scans `src/app` and `src/lib`).

### 2.1 Attempt rules the authoritative writers enforce

* **Idempotency** — key `(round, clientAttemptId)`. A retry must repeat the
  same immutable request: sentence, raw text, **effective grading mode**
  (stored in the new nullable `attempt_logs.match_mode`; an omitted/unknown
  mode means `relaxed`) and hint level (Shadowing: sentence and duration).
  Same request → the stored attempt, no writes. Anything different →
  `idempotency_key_reused_with_different_payload` (HTTP 409). Rows written
  before `037` have `match_mode = NULL` (never inferred); reusing such a key is
  a 409.
* **Practice validity** — an answer counts as practice only if it has content
  under the JavaScript whitespace set (`fn_js_has_content`): empty,
  space/tab/CR/LF/NBSP/U+2000–200A/U+3000/BOM-only answers are stored as history
  with `is_practice_valid = false`, earn no coverage and cannot complete a
  round. Wrong or hinted answers with content still count; validity is judged
  on the raw answer, not on the grading normalization.
* **Study-session attribution** (`fn_attribute_study_session`, one rule set
  for supplied and automatic ids) — a session is reused only if it is open,
  idle ≤ 30 minutes and attached to exactly this round; reuse bumps
  `last_activity_at` and adds the mode to `modes_used`. A supplied id is
  relationship-checked (same user, same video, same round or round-less →
  otherwise `study_session_mismatch`, 409) and then treated as a hint: an
  ended/expired/round-less session is never reopened or re-pointed; the
  automatic rule applies instead (closes the open session, opens a new one for
  this round). A retry never touches sessions and returns the original
  attribution. A late attempt for a superseded round (abandoned, or another
  round is active) is kept as history, attributed to a still-open session of
  that round if one exists, otherwise to none (`null`); it never closes or
  replaces the current round's session.

## 3. Two application releases (one codebase)

`PRACTICE_WRITE_PATH` fixes the write path **per deployment** — it is never
switched at runtime and never used as a fallback after a failure:

* **Preparation release** — `PRACTICE_WRITE_PATH=legacy`: the three writers
  use the Phase 2 bridges; explain-all already uses
  `fn_persist_session_assessment`; a blocked/failed recorded answer is a
  **503 (retryable) or error response, never a successful grade** (the
  Phase 2 route logged the failure and still returned the grade).
* **Phase 3 release** — variable unset (or `authoritative`): the new routes.

## 4. Rollout (in this order)

Run SQL in the Supabase SQL editor as `postgres`. Before every step, run
`supabase/phase3/00_preflight.sql` (read-only) and check the listed
precondition.

### Step 0 — apply `037` (safe, no user impact)
* Pre: `supabase migration list` shows `001`–`036` applied, `037` pending, no `038`.
* Run: `supabase db push`.
* Post: `select fn_phase3_status();` → `stage = prepared`; gate
  `paused = false, legacy_writes_retired = false, authoritative_writes_active = false`;
  `learning_sessions` still has `sessions_owner`/`sessions_anon_insert`;
  the app still works exactly as before.

### Step 1 — deploy the PREPARATION release
* Set `PRACTICE_WRITE_PATH=legacy` in the deployment environment, deploy this codebase.
* Confirm in the deployment platform that **every** serving instance runs it
  (no Phase 2-only instance left — explain-all on an old instance would fail
  after step 2).
* Smoke test: save progress, restart, answer a sentence, run "Explain all" on
  a results page (assessment persists after reload).

### Step 2 — close direct writes: `02_restrict_direct_writes.sql`
* Pre: step 1 confirmed. Post: stage `restricted`; policies =
  `[learning_sessions_owner_select]`. No user-visible change.

### Step 3 — pause and drain: `03_close_gate.sql` (maintenance starts)
* Pre: stage `restricted`. Waits for admitted bridge transactions to finish,
  then records `cutover_at` (`clock_timestamp()` after the lock).
* Users now get "Saving is paused for maintenance… your answer is kept" on
  saves, restarts and recorded answers (HTTP 503, `Retry-After: 30`). Reading,
  playback and guest grading keep working.

### Step 4 — backfill: `04_backfill.sql`
* Pre: stage `paused`. Review the printed summary: `current_rounds_left = 0`,
  `verified_attempts_left = 0`, anomaly and identity-resolution counts
  (see §6). Keep the output.

### Step 5 — deploy the PHASE 3 release (still paused)
* Unset `PRACTICE_WRITE_PATH` (or set `authoritative`), deploy.
* Until activation, new instances also answer 503 maintenance (the authoritative
  functions are not granted yet; the route confirms "not available" via
  `fn_practice_write_status` before calling it maintenance).
* Confirm in the platform that **every** serving instance runs the Phase 3
  release. (The platform's "100% new" signal does not prove old database
  calls have finished — step 6 handles those.)

### Step 6 — activate: `05_activate.sql`
* Pre: stage `backfilled`; step 5 confirmed.
* One transaction: sets the permanent `legacy_writes_retired` flag, drops the
  three bridges, grants the five authoritative functions to `authenticated`
  (exact signatures; anon/service_role/PUBLIC explicitly revoked and verified),
  sets `authoritative_writes_active`, reopens the gate. Maintenance ends.

### Step 7 — verify: `06_postflight.sql` + §8 checklist.

## 5. Queued / delayed legacy requests

A bridge call that had already started executing when activation began is
blocked on the gate row (`FOR SHARE` behind activation's `FOR UPDATE`). When
activation commits, that call re-reads the committed row, sees
`legacy_writes_retired = true` and raises `legacy_writes_retired` — **no
write** (rehearsed with a real concurrent connection). `DROP FUNCTION` alone
would not stop it. A legacy request arriving later finds no function
(`42883`/`PGRST202`). The flag cannot be reset (`legacy_writes_retired_is_permanent`
trigger), and `service_role` can no longer update the Phase 3 flags.

## 6. Backfill — what it does

* **Cohort:** every round still `provenance = 'current'` and every attempt
  still `verified` at backfill time. Before activation no authoritative write
  can exist (the functions refuse until activated), so everything present was
  written by legacy paths — including rows whose client-writable `started_at`
  lies after the boundary (reported as `started_after_cutover`, not excluded).
* **Captured first** (`phase3_backfill_rounds` / `phase3_backfill_attempts`,
  owner-only): original status, provenance, round number, required count,
  completion time, `started_at`, `updated_at`; attempt provenance and identity.
  A captured row is never overwritten.
* **Rounds:** `legacy_unverified`; `round_number` per (user, video) by
  `started_at`, then `id` (anonymous rows are each their own sequence, never
  grouped); `required_sentence_count` = eligible sentences of the pinned
  transcript (null if the pin is missing); completed rounds without a time get
  `completed_at = min(max(updated_at, started_at), cutover_at)` with
  `completed_at_approximate = true`. **`updated_at` is not touched** and the
  function refuses to run if user triggers exist on these tables.
* **Attempts:** `legacy_unverified`; `transcript_id`/`segment_id` filled only
  when the round's pin resolves **and** the stored reference text equals that
  segment's text; otherwise left null with the reason recorded. Never repinned
  to the latest transcript. `hint_level_used` stays null (unknown).
* Not fabricated: study sessions, Listening intervals, shadowing attempts, modes.
* **Rerun:** no-op after success; refused after activation; a failure rolls
  back completely (stage stays `paused`).
* Later: a legacy round keeps `legacy_unverified` even when new verified
  attempts are added; those attempts are `verified` individually.

Read-only checks afterwards:
```sql
select backfill_summary from phase3_cutover_state;
select orig_status, count(*), count(*) filter (where completed_at_inferred) from phase3_backfill_rounds group by 1;
select anomalies, count(*) from phase3_backfill_rounds where array_length(anomalies,1) > 0 group by 1;
select identity_resolution, count(*) from phase3_backfill_attempts group by 1;
```

## 7. Recovery

| Boundary | What happened | Recovery |
|---|---|---|
| Before step 2 | nothing changed in the DB | fix and retry; the app runs as in Phase 2 |
| Step 2 failed | lock timeout → rolled back | rerun `02` (idempotent) |
| Step 3 failed | could not get the gate lock in time → rolled back; gate open | rerun `03` (rehearsed with a stuck writer) |
| Paused, backfill not started | writes paused, no data changed | proceed to `04`, or `90_recovery_reopen_legacy.sql` to resume legacy service (nothing to undo) |
| Backfill attempted and rolled back | stage still `paused`, no audit rows | fix the reported cause (e.g. a stray trigger), rerun `04` |
| Backfill committed, activation not done | cohort classified; writes paused | **preferred:** finish steps 5–6. If you must postpone: roll the app back to the preparation release, then `90_recovery_reopen_legacy.sql`. Rows written by the bridges afterwards stay `current` and are captured as a **new batch** by the next `03` + `04` (new recorded boundary; earlier batches untouched). Never just `update app_write_gate set completion_writes_paused = false` by hand. |
| Activated, authoritative writes occurred | new verified rounds/attempts exist; bridges dropped | no return to legacy. Fix forward (app redeploy / new migration). Do not restore permissive policies or drop populated tables. A future maintenance pause: `update app_write_gate set completion_writes_paused = true` (the authoritative functions honor it); undo with `= false`. |

Wrong release at step 6 (a preparation-release instance still serving): its
saves fail with 500 ("write function missing" in the server log). Finish
deploying the Phase 3 release; nothing else is needed.

## 8. Manual acceptance checklist (after step 7)

1. Answer a sentence wrong, then right: the practice bar shows
   "Sentence accuracy 100%" (latest answer counts, attempts are separate).
2. Reload the page mid-lesson: sentence accuracy is the same (seeded from the server).
3. Skip a sentence and reach the end: "You reached the end of the video — N of
   M sentences practiced", no confetti; practice the skipped one → "Round complete!" with confetti once.
4. Restart: a new round starts on the current script; History shows the old
   round as "Ended"; its attempts remain on its results page.
5. Dashboard right after practicing: "Resume point", attempt count and
   "N% of answers correct" updated; "Completed Videos" counts distinct videos
   with a verified completion; videos whose only completion is from before
   the cutover appear as "+N earlier (unverified)" (a video is never in both).
6. Explain all on a results page, reload: assessment persisted.
7. Playback/resume checks from Phase 2 still pass (first Play/Space resumes at
   the saved sentence, Replay starts the sentence, pause → play continues).
8. `06_postflight.sql`: all matrix rows `ok`, bridges absent, verified
   attempts since activation > 0.

## 9. Verification performed (local) and what remains

**Real PostgreSQL** (disposable PostgreSQL 17.9 via `embedded-postgres`,
migrations `001`–`037` applied through `scripts/localdb/supabase-shim.sql`):

| Suite | Tests | Covers |
|---|---|---|
| `phase3-migrations-apply` | 1 | 001–037 apply; 037 activates nothing |
| `phase3-scoring-parity` | 3 | TS vs SQL normalize/correctness/error type, all 3 modes, 42 fixtures + 1,200 seeded fuzz pairs; documents the 032 divergence |
| `phase3-cutover-rehearsal` | 11 | 036 → 037 upgrade with historical data (no row changed; `match_mode` NULL on every existing attempt, also after backfill), restriction, drain, backfill + rerun, return-to-legacy batch 2, queued legacy call after activation, final matrix |
| `phase3-authoritative` | 16 | concurrency (final-sentence race, create/restart races), idempotency, conflicts, completion rules, mixed-mode coverage, study sessions, owner-only access |
| `phase3-recovery` | 4 | out-of-order stages, gate-close lock timeout, reopen before backfill |
| `phase3-operator-scripts` | 1 | the `supabase/phase3/*.sql` files as written, end to end |
| `phase3-review-fixes` | 15 | grading-mode idempotency (conflict, retry, defaults, NULL legacy mode), whitespace-only answers on the last sentence, study-session attribution (reuse, expiry, ended, modes, retry after closure, delayed old-round submission, round-less session, relationship rejects) |

To rerun: `npm install --no-save embedded-postgres@17.9.0-beta.17`,
`node scripts/localdb/start-embedded-postgres.mjs`, then
`LOCALDB_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres npx jest src/__tests__/integration/phase3`.
Any local PG 15+ with ICU works; the harness refuses non-localhost hosts.

**What the shim simulates:** roles `anon`/`authenticated`/`service_role`
(BYPASSRLS), `auth.users`/`auth.uid()`/`auth.role()` reading
`request.jwt.claims`, Supabase's default per-role grants in `public`, and
storage stubs. Identity is switched exactly as PostgREST does (`SET LOCAL
ROLE` + claims).

**Not verified through real Supabase HTTP APIs:** PostgREST error shapes
(e.g. that `42501` arrives as `error.code`), GoTrue sessions, the platform's
actual default privileges/role memberships, and the Phase 0/1/2 suites that
need `PHASE1_IT_*` (still skipped). The postflight SQL in §4 step 7 checks the
effective privileges on the real project. No real browser was driven.
