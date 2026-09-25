# Phase 2 migration runbook

Covers migrations `031_phase1_privilege_corrections.sql` through
`035_fn_session_activity_and_evaluation_functions.sql`. See
`.claude/video-learning-management-plan.md` §6/§8/§9/§12 (Phase 2) for the
design; this document is the operational procedure for applying these
migrations and deploying the corresponding application code.

**Status as of this pass: none of these migrations have been applied to
any Supabase project, linked or otherwise, and no application code has
been deployed.** Everything below is prepared and locally
reasoned-through/tested where a real Postgres instance was available (see
the completion report for exactly which tests actually ran).

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
| `034_provenance_backfill_and_completion_cutover.sql` | **`036_provenance_backfill_and_completion_cutover.sql`** | Shifted +2 — **not created in this pass** |
| `035_fn_delete_transcript_revision.sql` | **`037_fn_delete_transcript_revision.sql`** | Shifted +2 — **not created in this pass** |

`.claude/video-learning-management-plan.md` is updated throughout to use
the new numbers. Migrations `001`-`030` are untouched — none were
modified, renamed, repaired, or reapplied.

## 2. Rollout stages — do not conflate these

1. **Privilege patch applied** — `031` run against the target project.
   Corrects `attempt_logs`/`app_write_gate`/`migration_030_abandoned_rounds_log`
   grants. No application code change required for this step alone.
2. **RPC migrations applied** — `032`-`035` run. Creates every Phase 2
   function; the five authoritative round/attempt functions are created
   **dormant** (no EXECUTE grant to any application role); the study-
   session/activity/provider-persistence functions and the three legacy
   bridges are granted to `authenticated`/`service_role` as designed. At
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
   backfill (`036`), retires the legacy bridges, and tightens
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
-- exactly the intended role only.
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

**NOT performed in this pass** (no `supabase`/`docker` CLI available in
this environment, same as Phase 0/1): applying any of `031`-`035` to a
real Postgres instance; running the new integration suite; the preflight/
postflight queries above, against real data; deploying the application.

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
