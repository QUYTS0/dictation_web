# Phase 1 migration runbook

Covers migrations `022_practice_round_columns.sql` through
`030_practice_round_active_uniqueness.sql`. See
`.claude/video-learning-management-plan.md` §8/§12 (Phase 1) for the full
design; this document is the operational procedure for actually applying
these migrations to a real (local, staging, or production) Supabase
project.

**Status as of this pass: none of these migrations have been applied to
any Supabase project, linked or otherwise.** Everything below is prepared
and locally reasoned-through, not executed against a real database in this
environment (no `supabase`/`docker` CLI is available here — see the
Verification section).

## 1. What these migrations do (summary)

| Migration | Adds |
|---|---|
| 022 | `learning_sessions` columns: `round_number`, `completed_at`, `required_sentence_count`, `provenance` |
| 023 | `study_sessions` table (owner-SELECT-only RLS) |
| 024 | `attempt_logs` columns + idempotency index; tightens `attempts_owner` to SELECT-only |
| 025 | `shadowing_attempts` table (owner-SELECT + service-role-write RLS) |
| 026 | `listening_progress` table + legacy backfill from `listening_sessions` |
| 027 | `user_videos` table (owner-CRUD RLS) + membership backfill |
| 028 | `activity_flush_log` table (owner-SELECT-only RLS) |
| 029 | `users.is_admin` + self-grant-prevention trigger; `transcripts` size-estimate columns; `app_write_gate` singleton |
| 030 | Duplicate-active-round reconciliation (audit-logged) + `learning_sessions_one_active_per_video` unique index |

None of these wire into any application route yet. `learning_sessions`'
own RLS is **not** touched — `save-progress`/`session/restart` keep
working exactly as they do today, with one narrow addition (§4 below).

## 2. Before you run this in a real environment

1. **Take a database backup / confirm point-in-time recovery is available**
   for the target project, as you would before any migration that changes
   existing row data (only migration `030` does; `022`-`029` are additive
   schema only).
2. Confirm which "grant-defaults" regime the target project is on: an
   older project may still auto-grant broad table privileges to
   `anon`/`authenticated` on newly created tables; a newer one does not.
   Every new table in `023`-`029` explicitly `REVOKE`s and re-`GRANT`s
   exactly the intended privileges, so this is handled either way — but
   it's worth confirming with:
   ```sql
   select grantee, table_name, privilege_type
   from information_schema.role_table_grants
   where table_schema = 'public' and table_name in
     ('study_sessions','attempt_logs','shadowing_attempts','listening_progress',
      'user_videos','activity_flush_log','app_write_gate','migration_030_abandoned_rounds_log')
   order by table_name, grantee;
   ```
   (Run this again **after** migrating — see §5's postflight queries.)
3. Set a `lock_timeout` for the session that runs migration `030`
   specifically (see §3).

## 3. Migration 030's locking, timeout, and retry expectations

Migration `030` is the one migration in this phase that changes existing
row data and creates an index that enforces a new invariant. It:

1. Opens a transaction.
2. `LOCK TABLE learning_sessions IN SHARE MODE` — blocks every concurrent
   `INSERT`/`UPDATE`/`DELETE` on `learning_sessions` (the lock every
   ordinary `CREATE UNIQUE INDEX` would take anyway) for the duration of
   the transaction, but does **not** block ordinary `SELECT` reads. This
   is what makes "decide survivors" and "enforce uniqueness" atomic
   against `save-progress`/`session/restart`, which write
   `learning_sessions` via the caller's own client today.
3. Reconciles duplicate active rounds, recording an audit trail.
4. Creates `learning_sessions_one_active_per_video`.
5. Commits.

**Timeout:** run
```sql
set lock_timeout = '5s';
```
(adjust to taste) in the same session immediately before applying this
migration in any environment with real traffic. Without it, if the lock
can't be granted immediately (e.g. a long-running transaction already
holds a conflicting lock on `learning_sessions`), the request queues —
and because Postgres grants conflicting lock requests in arrival order,
every ordinary query issued after it queues up behind it too, for as long
as the blocking transaction runs. A `lock_timeout` failure surfaces as a
clear, fast error instead.

**Retry:** if the migration fails with a lock-timeout error, do **not**
increase the timeout and retry immediately in a loop. Instead: identify
and address the long-running blocking transaction (or wait for a
lower-traffic deployment window), then re-run. The migration is safe to
retry from scratch — its `CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE
INDEX IF NOT EXISTS` guards make a from-the-top re-run idempotent, and a
genuine failure partway through rolls back the entire transaction (§6
below), so there is never a partially-applied state to clean up by hand.

**Expected lock duration:** the reconciliation query scans all `active`
rows in `learning_sessions` once; at this app's current scale (per the
plan's own sizing assumptions — a handful of users, low hundreds of
sessions each at most) this should complete in well under a second. If the
target table is much larger than expected, measure the preflight query's
own execution time first (§4) as a proxy before deciding on a
`lock_timeout` value.

## 4. Preflight (read-only — run before applying migration 030)

Run this against the target database **before** migration 030, to see
exactly which rows it will affect:

```sql
with ranked as (
  select id, user_id, youtube_video_id, status, updated_at, started_at,
    row_number() over (
      partition by user_id, youtube_video_id
      order by updated_at desc, started_at desc, id desc
    ) as rn
  from learning_sessions
  where status = 'active' and user_id is not null
)
select
  r1.user_id, r1.youtube_video_id,
  r1.id as survivor_round_id, r1.updated_at as survivor_updated_at,
  r2.id as would_be_abandoned_round_id, r2.updated_at as abandoned_updated_at
from ranked r1
join ranked r2
  on r1.user_id = r2.user_id
 and r1.youtube_video_id = r2.youtube_video_id
 and r1.rn = 1 and r2.rn > 1
order by r1.user_id, r1.youtube_video_id, r2.rn;
```

Zero rows returned means there is nothing for migration 030 to reconcile —
the unique index will apply cleanly with no data change. Review the
output before proceeding if it's non-empty; this query makes no changes.

## 5. Postflight (run after applying all of 022-030)

Confirm the reconciliation and index:
```sql
-- Should return zero rows: no (user_id, youtube_video_id) has more than
-- one active round.
select user_id, youtube_video_id, count(*)
from learning_sessions
where status = 'active' and user_id is not null
group by user_id, youtube_video_id
having count(*) > 1;

-- What (if anything) migration 030 actually changed:
select count(*) from migration_030_abandoned_rounds_log;

select indexname from pg_indexes
where tablename = 'learning_sessions' and indexname = 'learning_sessions_one_active_per_video';
```

Confirm explicit GRANTs landed as intended (repeat the query from §2 step
2) and spot-check RLS is doing what's documented:
```sql
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('study_sessions','attempt_logs','shadowing_attempts',
                     'listening_progress','user_videos','activity_flush_log',
                     'app_write_gate','migration_030_abandoned_rounds_log')
order by tablename, policyname;
```

Confirm the Dictation writer still works end-to-end (manual or automated
smoke test): submit a Dictation answer for a real session and confirm an
`attempt_logs` row is written — this exercises the service-role insert
path migration 024 was specifically checked not to break.

Confirm `users.is_admin` protection:
```sql
-- As an ordinary authenticated user (via the app or a REST call with
-- their JWT), attempt to PATCH your own is_admin to true, then:
select is_admin from users where id = '<that user's id>';
-- must still read false.
```

## 6. Rollback

**Additive migrations (022, 023, 025-029):** no column is dropped,
renamed, or retyped by any Phase 1 migration. The standard rollback is to
revert application code to not reference the new tables/columns (trivial
here, since nothing in the app references them yet) and leave the new
tables and any data in them in place — this plan's rollback procedure
never drops a table that may hold real data. If a genuine schema mistake
(not just a change of plan) requires dropping something, that is a
separate, manually-reviewed decision outside this runbook's scope.

**024's RLS tightening (`attempts_owner` → `attempt_logs_owner_select`):**
reversible by re-creating the original policy:
```sql
drop policy "attempt_logs_owner_select" on attempt_logs;
create policy "attempts_owner" on attempt_logs for all
  using (session_id in (select id from learning_sessions where user_id = auth.uid()));
```
Only do this if something depends on the old permissive shape — nothing in
this codebase does today (verified: the only writer already uses the
service-role client).

**030 (reconciliation + uniqueness) — NOT a single-statement rollback.**
Restoring rows while the unique index still exists fails outright (it
would recreate the exact state the index forbids). Ordered rollback:
```sql
drop index learning_sessions_one_active_per_video;
update learning_sessions set status = 'active'
  where id in (select round_id from migration_030_abandoned_rounds_log);
```
This restores the `status` flag on the previously-abandoned rows to
exactly what it was before migration 030 ran. It does **not** undo
anything that happened *because* the surviving round was treated as the
sole active one during the intervening period (new attempts recorded
against the survivor, a completion that occurred under the new
invariant). If any later phase has already shipped and relies on round
uniqueness by the time this rollback runs, restoring multiple active
rounds reintroduces the exact ambiguity migration 030 existed to remove —
only treat this as a clean, complete operation if performed **before**
that point.

**029's `app_write_gate`:** created in its unpaused state and not consulted
by any writer yet, so there is nothing to roll back beyond dropping the
table if truly unwanted — not recommended, since a later phase depends on
it existing.

## 7. Local/staging verification performed vs. pending

**Performed in this pass:** every migration file reviewed against the
actual current schema (`supabase/migrations/001`-`021`) and the actual
current route implementations (`save-progress`, `session/restart`,
`dictation/check`) for compatibility; `npx tsc --noEmit`, `npm run lint`,
`npm run build`, and the mocked/unit Jest tier all run against the
resulting application code (results in the Phase 1 completion report).

**NOT performed in this pass (no `supabase`/`docker` CLI available in
this environment):**
- Applying any of these migrations to a real Postgres instance, local or
  otherwise.
- Running `src/__tests__/integration/phase1-schema.integration.test.ts`
  (written and gated to skip cleanly without the required env vars — see
  that file's header for exact setup/run commands).
- The preflight/postflight queries above, against real data.

Before applying to a staging or production project: run `supabase start`
+ `supabase db reset` locally, execute the integration test file above
against it, manually run the preflight query (§4), then apply, then run
the postflight queries (§5) and the integration test file again against
the target if feasible.
