# Phase 2 migration runbook

Covers migrations `031_phase1_privilege_corrections.sql` through
`035_fn_session_activity_and_evaluation_functions.sql`, plus the
post-Phase-2 repair migration `036_phase2_user_rpc_privilege_corrections.sql`
(§8). See `.claude/video-learning-management-plan.md` §6/§8/§9/§12 (Phase 2)
for the design; this document is the operational procedure for applying
these migrations and deploying the corresponding application code.

**Status:** the user reports `001`-`035` applied to their Supabase project
(and ran the postflight in §5, which is how the §8 permission mismatch was
found). `036` and the post-Phase-2 client repair are **not applied / not
deployed** — they were only prepared locally. No real Postgres instance was
available while preparing either pass: every real-database test below was
written and **skipped**, never run (see §6).

## 1. Migration numbering — old plan numbers → actual files

The plan's §8.1 table originally numbered the Phase 2/3 migrations
`031`-`035` (RPC functions), `034` (provenance backfill), `035` (revision
deletion). This pass inserted a corrective privilege migration (discovered
from the user's own Phase 1 postflight check) and a small additive schema
correction (discovered while implementing Word Match persistence),
shifting everything after them by two:

| Old plan number | New file | Reason |
|---|---|---|
| *(none — new)* | `031_phase1_privilege_corrections.sql` | Corrects Phase 1 GRANT gaps found by the user's postflight check |
| `031_fn_record_dictation_attempt.sql` | `032_fn_record_dictation_attempt.sql` | Shifted +1 |
| `032_fn_record_shadowing_attempt.sql` | `033_fn_record_shadowing_attempt.sql` | Shifted +1 |
| *(none — new)* | `034_word_match_request_seq.sql` | `shadowing_attempts` needed a Word-Match-specific sequence column, independent of `azure_eval_request_seq`, to implement `fn_persist_word_match_result`'s staleness protection at all — discovered while implementing §8 |
| `033_fn_session_activity_and_evaluation_functions.sql` | `035_fn_session_activity_and_evaluation_functions.sql` | Shifted +2 |
| *(none — new, post-Phase-2 repair)* | `036_phase2_user_rpc_privilege_corrections.sql` | Removes the `service_role` EXECUTE that `035` left on the four user-actor functions (§8) |
| `034_provenance_backfill_and_completion_cutover.sql` | **`037_provenance_backfill_and_completion_cutover.sql`** | Shifted +3 (was `036` after the Phase 2 pass) — **not created** |
| `035_fn_delete_transcript_revision.sql` | **`038_fn_delete_transcript_revision.sql`** | Shifted +3 (was `037` after the Phase 2 pass) — **not created** |

`.claude/video-learning-management-plan.md` is updated throughout to use
the new numbers. Migrations `001`-`035` are untouched by the repair pass —
none were modified, renamed, repaired, or reapplied.

## 2. Rollout stages — do not conflate these

1. **Privilege patch applied** — `031` run against the target project.
   Corrects `attempt_logs`/`app_write_gate`/`migration_030_abandoned_rounds_log`
   grants. No application code change required for this step alone.
2. **RPC migrations applied** — `032`-`035` run. Creates every Phase 2
   function; the five authoritative round/attempt functions are created
   **dormant** (no EXECUTE grant to any application role); the study-
   session/activity/provider-persistence functions and the three legacy
   bridges are granted to `authenticated` (user-actor) or `service_role`
   (backend-only) — but see §8: `035` alone leaves `service_role` with an
   unintended EXECUTE on the four user-actor functions, which `036`
   removes. At
   this point the database is ready, but the **application still writes
   the old way** (raw `.from()` calls) until stage 3.
3. **Bridge application code deployed everywhere** — `save-progress`,
   `session/restart`, and `dictation/check` all switched to call
   `fn_legacy_save_progress`/`fn_legacy_restart_round`/
   `fn_legacy_record_dictation_attempt` via `.rpc()` (this pass's code
   changes). **Until every running instance is on this code, do not treat
   the gate as meaningful** — an old instance still doing a raw
   `.from("learning_sessions").insert(...)` write is completely unaffected
   by `app_write_gate`, since it never calls a gate-checking function at
   all. This is a real, load-bearing prerequisite for Phase 3, not a
   formality — see §5 below.
4. **Phase 2 verified** — the checks in §6 below pass against the target
   project after stages 1-3.
5. **Phase 3 — separately authorized and executed later.** Grants EXECUTE
   on the five dormant functions to `authenticated`, runs the provenance
   backfill (`037`), retires the legacy bridges, and tightens
   `learning_sessions`' RLS. **None of this happens as part of Phase 2.**
   The gate stays open (`completion_writes_paused = false`) through all of
   Phase 2's ordinary operation — Phase 2 does not pause it, and nothing
   in Phase 2 depends on it ever being paused.

## 3. Preflight (run before applying `031`-`035`)

Table privileges (confirms the exact gap this pass corrects):
```sql
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('attempt_logs', 'app_write_gate', 'migration_030_abandoned_rounds_log')
  and grantee in ('anon', 'authenticated', 'service_role')
order by table_name, grantee, privilege_type;
```

Schema dependency check — `035` needs `word_match_request_seq` (`034`) and
every Phase 1 table; `032`/`033` need `attempt_logs`/`shadowing_attempts`'
idempotency indexes:
```sql
select column_name from information_schema.columns
where table_name = 'shadowing_attempts' and column_name in ('azure_eval_request_seq', 'word_match_request_seq');
-- word_match_request_seq should NOT exist yet before 034 runs.

select indexname from pg_indexes where tablename in ('attempt_logs', 'shadowing_attempts')
  and indexname like '%idempotency%';
```

Gate state (must be unpaused before Phase 2 operation begins):
```sql
select * from app_write_gate where id = 1;
```

Active-round uniqueness (Phase 1's own postflight, re-checked since `035`'s
functions assume it):
```sql
select user_id, youtube_video_id, count(*) from learning_sessions
where status = 'active' and user_id is not null
group by user_id, youtube_video_id having count(*) > 1;
-- must return zero rows.
```

## 4. Applying

```
supabase db push   # or your normal migration-apply command
```
applies `031` through `035` in order. Each migration is self-contained
(its own `CREATE`/`REVOKE`/`GRANT` block in one transaction) — no manual
intervention is required between files. `031` and `034` are pure schema/
privilege corrections with no locking concerns beyond ordinary DDL; `032`,
`033`, and `035` only `CREATE OR REPLACE FUNCTION` and issue
`REVOKE`/`GRANT` — they do not touch existing row data and take no
row-level locks.

Then deploy the application code containing this pass's three route
changes (stage 3, §2) to **every** running instance before considering
Phase 2 "live." **A database GRANT and an application deployment are not
one atomic operation** — there is necessarily a window between "migrations
applied" and "every instance is on the new code," during which old
instances keep writing the old way (harmlessly — they still have the
table-level privileges `031` preserves for their actual write paths, e.g.
`attempt_logs` SELECT+INSERT for `service_role`). Do not pause the gate
during this window; nothing depends on it yet.

## 5. Postflight

Table privileges (re-run §3's query — `authenticated`/`anon` should have
lost INSERT/UPDATE/DELETE/TRUNCATE on `attempt_logs`; `service_role`
should show only SELECT+INSERT):
```sql
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('attempt_logs', 'app_write_gate', 'migration_030_abandoned_rounds_log')
  and grantee in ('anon', 'authenticated', 'service_role')
order by table_name, grantee, privilege_type;
```

Function signatures, owners, SECURITY DEFINER, and effective EXECUTE:
```sql
select p.proname, p.prosecdef as security_definer, r.rolname as owner
from pg_proc p join pg_roles r on r.oid = p.proowner
where p.proname like 'fn\_%' escape '\' and p.pronamespace = 'public'::regnamespace
order by p.proname;

-- The five dormant functions: every one of these must read false for
-- anon/authenticated/service_role.
select has_function_privilege('anon', 'fn_create_or_get_active_round(text)', 'EXECUTE') as anon_ok,
       has_function_privilege('authenticated', 'fn_create_or_get_active_round(text)', 'EXECUTE') as auth_ok,
       has_function_privilege('service_role', 'fn_create_or_get_active_round(text)', 'EXECUTE') as service_ok;
-- Repeat for fn_update_resume_position(uuid,integer,numeric),
-- fn_restart_round(text),
-- fn_record_dictation_attempt(uuid,text,integer,uuid,text,text,text,uuid,uuid,smallint),
-- fn_record_shadowing_attempt(uuid,text,integer,uuid,numeric,uuid,uuid).

-- User-actor / backend-only functions granted now — should read true for
-- exactly the intended role only. (After `035` alone, service_role ALSO
-- reads true for the four user-actor functions — that is the mismatch `036`
-- corrects; use §8's full-matrix query rather than these single checks.)
select has_function_privilege('authenticated', 'fn_get_or_create_study_session(text,uuid)', 'EXECUTE');
select has_function_privilege('authenticated', 'fn_flush_study_activity(text,uuid,uuid,text,jsonb,uuid,numeric,text)', 'EXECUTE');
select has_function_privilege('authenticated', 'fn_legacy_save_progress(uuid,text,uuid,integer,numeric,numeric,integer,text)', 'EXECUTE');
select has_function_privilege('authenticated', 'fn_legacy_restart_round(text,uuid)', 'EXECUTE');
select has_function_privilege('service_role', 'fn_persist_azure_result(uuid,integer,text,numeric,numeric,numeric,numeric,numeric,text,text)', 'EXECUTE');
select has_function_privilege('service_role', 'fn_persist_word_match_result(uuid,integer,text,numeric,numeric)', 'EXECUTE');
select has_function_privilege('service_role', 'fn_legacy_record_dictation_attempt(uuid,integer,text,text,text,text,boolean,text)', 'EXECUTE');
```

Gate state (must remain unpaused through ordinary Phase 2 operation):
```sql
select * from app_write_gate where id = 1;  -- completion_writes_paused = false
```

Active-round uniqueness (unaffected by Phase 2, re-checked for safety):
```sql
select user_id, youtube_video_id, count(*) from learning_sessions
where status = 'active' and user_id is not null
group by user_id, youtube_video_id having count(*) > 1;
```

Behavioral smoke test: save progress, restart, and submit a Dictation
answer through the actual deployed app; confirm each still works exactly
as before (response shapes unchanged) and that `attempt_logs`/
`learning_sessions` rows are written as expected.

## 6. Verification performed vs. pending

**Performed in this pass:** every migration file reviewed against the
actual current schema and the actual current route implementations
(`save-progress`, `session/restart`, `dictation/check` — plus a writer
inventory search that additionally found `session/[sessionId]/explain-all/
route.ts` writing `learning_sessions.ai_assessment`/
`.ai_assessment_generated_at`, see the completion report for why that
writer does not need a Phase 2 bridge); `npx tsc --noEmit`, `npm run lint`,
`npm run build`, and the mocked/unit Jest tier all run against the
resulting application code. A new real-Postgres integration suite,
`src/__tests__/integration/phase2-functions.integration.test.ts`, is
written and gated to skip cleanly when its required env vars are absent.

**Correction to the Phase 2 completion report's wording:** that report's
test totals ("992 passed, 60 skipped") counted only the mocked/unit tier as
passed. The real-Postgres suites — Phase 0 (`transcript-revision-publish.integration.test.ts`), Phase 1
(`phase1-schema.integration.test.ts`) and Phase 2
(`phase2-functions.integration.test.ts`) — were **written and skipped, never
executed**. Nothing about locking, idempotency, the write fence, or the
effective privilege matrix has been verified against a real database by
this project's automated tests. The only real-database evidence is the
user's own postflight SQL run against their project (§5), which is what
exposed the §8 mismatch — and that suite also had no assertion that
`service_role` is denied the user-actor functions, which is why it didn't
catch it (the new `postphase2-privileges.integration.test.ts` does).

**NOT performed in this pass** (no `supabase`/`docker` CLI available in
this environment, same as Phase 0/1): applying any of `031`-`036` to a
real Postgres instance from here; running any integration suite; deploying
the application. (`031`-`035` were later applied by the user.)

## 7. Corrections to the plan's own future-runbook assumptions

Found while writing this document — corrected here, in documentation only,
**without performing the Phase 3 cutover**:

- **A database GRANT and an application deployment are not one atomic
  transaction.** Phase 3's runbook (§8.14 of the plan) must not assume
  granting EXECUTE on the five dormant functions and deploying the route
  cutover happen at the same instant — there is a real window between
  them. The correct order is: deploy code that CAN call the new functions
  but campaign-flag/feature-gate it off, THEN grant EXECUTE, THEN flip the
  flag — or accept a brief window where the grant exists slightly before
  the code that uses it, never the reverse (granting after deploying code
  that already expects to call it would produce real user-facing errors
  during the gap).
- **Legacy bridges must be retired or permanently disabled while the gate
  is still closed, before reopening it.** If Phase 3 pauses the gate,
  performs the provenance backfill, then reopens the gate WITHOUT first
  retiring `fn_legacy_save_progress`/`fn_legacy_restart_round`/
  `fn_legacy_record_dictation_attempt` (e.g. an old client/instance still
  calling them), reopening the gate re-admits legacy-path writes that the
  backfill's `provenance='legacy_unverified'` tagging already assumed had
  stopped — corrupting the boundary the backfill relied on. The bridges
  must be dropped (or their EXECUTE revoked) BEFORE the gate reopens, not
  after.
- **Recovery before vs. after the provenance backfill needs different
  procedures.** A failure detected before the backfill has run is a
  simple retry (nothing has changed yet). A failure detected AFTER the
  backfill has tagged rows `legacy_unverified` but before the cutover
  fully completes needs a procedure that accounts for those tags already
  existing — a blind retry of "the same steps" is not correct in that
  state and must not be documented as such.
- **`now()` is transaction-start time, not the actual fence boundary.** If
  a Phase 3 fence transaction waits for in-flight writers to drain (by
  acquiring the gate's exclusive lock, mirroring this pass's write-fence
  test), the timestamp that should anchor "everything before this instant
  is old, everything after is new" must be captured AFTER the lock is
  acquired, via `clock_timestamp()` (which advances during a transaction),
  never `now()` (frozen at transaction start, which could predate the
  point where the lock was actually granted and writers actually drained).
- **The gate is not yet a system-wide write fence.** As long as any old
  application instance can still reach a raw `.from("learning_sessions")`
  write (i.e., stage 3 of §2 above is incomplete on any instance) or any
  future route writes `learning_sessions`/`attempt_logs` without going
  through a gate-checking function, pausing `app_write_gate` does **not**
  actually stop all writes — it only stops the three bridges this pass
  created. Phase 3 must not proceed on the assumption that pausing the
  gate is sufficient without first confirming every writer is
  gate-aware (this pass's writer inventory is the starting point for that
  confirmation, not a substitute for re-checking at Phase 3 time — new
  writers may have been added since).

## 8. Post-Phase-2 repair — `036` and the resume/Continue Learning fixes

### 8.1 What `036` corrects, and why

The user's postflight showed `has_function_privilege('service_role', …,
'EXECUTE') = true` for the four user-actor functions
(`fn_get_or_create_study_session`, `fn_flush_study_activity`,
`fn_legacy_save_progress`, `fn_legacy_restart_round`). Cause, confirmed in
the repository: `035` revoked them `from public, anon, authenticated` and
re-granted `authenticated`, but — unlike every other block in that file —
never named `service_role`. Supabase's default privileges for the `public`
schema grant EXECUTE on each new function directly to `anon`,
`authenticated` and `service_role`, so `service_role` simply kept its
creation-time grant. No code calls these four with the service client.

`036` revokes EXECUTE from `public, anon, service_role` on the four exact
signatures, re-grants `authenticated`, and then **asserts the effective
result inside the same transaction** (overload count = 1 per name;
`authenticated` true; `anon`/`service_role` false via
`has_function_privilege`; no PUBLIC ACL entry). If any assertion fails the
whole migration rolls back with a message naming the function. If it fails
with "service_role still has effective EXECUTE", `service_role` is getting
the privilege through role membership, not a direct grant — check
`select pg_has_role('service_role','authenticated','member');` and stop:
do **not** change Supabase role memberships or default privileges to force
the matrix; report it instead. Nothing else is touched: no other function's
ACL, no helper SECURITY mode, no default privileges, no role membership.

### 8.2 Deployment order

1. Apply `036` only (`supabase db push` — `037`/`038` do not exist, so
   nothing later can be pushed by accident). Safe at any time relative to
   the app deploy: no deployed code calls these functions as `service_role`.
2. Run the §8.3 postflight. Every row must say `ok = true`.
3. Deploy the application build containing the client repair (§8.4) to
   every instance. It needs no schema change; its order relative to step 1
   doesn't matter.
4. Run the §8.5 manual checklist.
5. Keep `app_write_gate.completion_writes_paused = false`. Do not toggle it.

### 8.3 Postflight — full function matrix (after `036`)

```sql
with expected(sig, anon, authed, service) as (values
  -- dormant authoritative (Phase 3 activates)
  ('public.fn_create_or_get_active_round(text)', false, false, false),
  ('public.fn_update_resume_position(uuid,integer,numeric)', false, false, false),
  ('public.fn_restart_round(text)', false, false, false),
  ('public.fn_record_dictation_attempt(uuid,text,integer,uuid,text,text,text,uuid,uuid,smallint)', false, false, false),
  ('public.fn_record_shadowing_attempt(uuid,text,integer,uuid,numeric,uuid,uuid)', false, false, false),
  -- user-actor
  ('public.fn_get_or_create_study_session(text,uuid)', false, true, false),
  ('public.fn_flush_study_activity(text,uuid,uuid,text,jsonb,uuid,numeric,text)', false, true, false),
  ('public.fn_legacy_save_progress(uuid,text,uuid,integer,numeric,numeric,integer,text)', false, true, false),
  ('public.fn_legacy_restart_round(text,uuid)', false, true, false),
  -- backend-only
  ('public.fn_persist_azure_result(uuid,integer,text,numeric,numeric,numeric,numeric,numeric,text,text)', false, false, true),
  ('public.fn_persist_word_match_result(uuid,integer,text,numeric,numeric)', false, false, true),
  ('public.fn_legacy_record_dictation_attempt(uuid,integer,text,text,text,text,boolean,text)', false, false, true),
  -- private helpers
  ('public.fn_check_write_gate()', false, false, false),
  ('public.fn_eligible_segment_count(uuid)', false, false, false),
  ('public.fn_merge_intervals(jsonb)', false, false, false),
  ('public.fn_intervals_union_length(jsonb)', false, false, false),
  ('public.fn_intervals_intersect(jsonb,jsonb)', false, false, false),
  ('public.fn_transcript_valid_union(uuid)', false, false, false),
  ('public.fn_normalize_dictation_text(text,text)', false, false, false),
  ('public.fn_round_coverage(uuid,integer)', false, false, false)
)
select e.sig,
       has_function_privilege('anon', e.sig, 'EXECUTE')          as anon_exec,
       has_function_privilege('authenticated', e.sig, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', e.sig, 'EXECUTE')  as service_exec,
       exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               where p.oid = e.sig::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
       (has_function_privilege('anon', e.sig, 'EXECUTE') = e.anon
        and has_function_privilege('authenticated', e.sig, 'EXECUTE') = e.authed
        and has_function_privilege('service_role', e.sig, 'EXECUTE') = e.service
        and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        where p.oid = e.sig::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE')) as ok
from expected e
order by ok, e.sig;
-- Expect 20 rows, all ok = true (failures sort first).
```

Overloads — each name must appear exactly once (an extra overload would
not be covered by the signatures above):
```sql
select p.proname, count(*) as overloads,
       string_agg(pg_get_function_identity_arguments(p.oid), ' | ') as signatures
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('fn_create_or_get_active_round','fn_update_resume_position','fn_restart_round',
    'fn_record_dictation_attempt','fn_record_shadowing_attempt','fn_get_or_create_study_session',
    'fn_flush_study_activity','fn_legacy_save_progress','fn_legacy_restart_round','fn_persist_azure_result',
    'fn_persist_word_match_result','fn_legacy_record_dictation_attempt','fn_check_write_gate',
    'fn_eligible_segment_count','fn_merge_intervals','fn_intervals_union_length','fn_intervals_intersect',
    'fn_transcript_valid_union','fn_normalize_dictation_text','fn_round_coverage')
group by p.proname
having count(*) <> 1;
-- Must return zero rows.
```

Role inheritance (the matrix above must not depend on it):
```sql
select pg_has_role('service_role', 'authenticated', 'member') as service_in_authenticated,
       pg_has_role('service_role', 'anon', 'member')          as service_in_anon;
-- Both false on a standard Supabase project.
```

Gate (must stay open):
```sql
select completion_writes_paused, paused_at from app_write_gate where id = 1;  -- false, null
```

Automated equivalent (local/disposable stack only, never production):
`src/__tests__/integration/postphase2-privileges.integration.test.ts`
(same `PHASE1_IT_*` env vars as the Phase 1/2 suites; also makes real
anon/authenticated/service_role PostgREST calls expecting `42501`).

### 8.4 Client repair shipped with this pass (no schema change)

- **First Play/Space after reopening** — restoring the sentence index also
  called `seekTo()` on the cued, never-played YouTube player (from `onReady`
  or the restore effect). The IFrame API documents that `seekTo()` on a
  cued video starts playback, which browsers' autoplay policy blocks
  without a user gesture, so that seek is not a reliable way to position
  the video (not verified in a real browser from here); Play and Space
  then called a bare `playVideo()`, which started at 0:00. In Shadowing
  the player's per-sentence auto-pause also still pointed at sentence 1.
  Now the restore **arms** a start target on the player (`setStartTarget`)
  and that instance's first `playVideo()` seeks to it inside the user's own
  click/keypress — the same seek-then-play Replay has always used — and
  aligns the auto-pause with the selected sentence. Resolution rule: the
  checkpoint's saved time if it lies inside the checkpoint's sentence,
  otherwise that sentence's start (`src/lib/utils/resumeTarget.ts`).
- **Initialization autosave** — saves before first playback used the
  player's 0:00 default as the checkpoint time; the tab-hide/pagehide save
  could also run while the checkpoint was still unknown (resume check
  failed). Now saves before first playback use the restored target, passive
  saves wait until the checkpoint is known, and a failed resume check never
  creates/overwrites a round at sentence 1 / 0:00.
- **Continue Learning / History** — the bar was `accuracy` (attempt-based
  answer accuracy) drawn as if it were video progress; removed. The
  percentage is now labeled "N% of answers correct" and hidden when there
  are no attempts; "Saved at sentence N" → "Resume point: sentence N" (the
  checkpoint is shared by all three modes); "1 attempt"/"2 attempts"; the
  "Dictation" badge (which only meant "a learning_sessions row") removed.
- **Cache** — every confirmed save now invalidates the Dashboard summary
  query (marks it stale; refetches only if mounted), so returning to
  Dashboard within the 60s `staleTime` shows the new checkpoint.

### 8.5 Manual verification checklist (real browser, after deploying)

1. Open a video in Dictation, answer sentence 1 correctly (checkpoint =
   sentence 2). Go to Dashboard via the app header. The card shows "Resume
   point: sentence 2 · 1 attempt · 100% of answers correct", no bar, no
   "Dictation" badge — immediately, not after a minute.
2. Reopen from Continue Learning, switch to Listening (or Shadowing), and
   **without pressing Replay** press Space: playback starts at sentence 2
   (around its start), not 0:00. Repeat with a fresh reopen and the Play
   button.
3. Pause mid-sentence, press Play: it continues from the paused point.
4. Reopen, do nothing, close the tab. Reopen: still sentence 2.
5. Replay starts at the beginning of the selected sentence.
6. Known limitation, expected: listen on to sentence 6 in Listening and go
   back to Dashboard through in-app navigation — the resume point stays at
   sentence 2. Listening playback has no save trigger of its own (only
   Next/Previous/jump and tab-hide/pagehide save); an independent Listening
   position is Phase 5 work, not something this repair adds.
