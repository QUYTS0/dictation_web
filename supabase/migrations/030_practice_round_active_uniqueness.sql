-- =====================================================
-- Phase 1 — Duplicate-active-round reconciliation + uniqueness
--
-- Moved from the old "034"/"Phase 7" position to run immediately after the
-- rest of Phase 1's schema, before any Phase 2 function is written against
-- an assumption of round uniqueness (R21 in the plan).
--
-- This migration CHANGES EXISTING ROW DATA (learning_sessions.status) --
-- unlike every other Phase 1 migration, which only adds schema. Treated
-- accordingly: audit-logged, atomic, and lock-guarded against the app's
-- existing writers (session/save-progress and session/restart both write
-- learning_sessions.status via the caller's own RLS-respecting client
-- today, confirmed by direct read of both routes).
--
-- DEPLOYMENT: before applying this migration against a project with real
-- traffic, run
--   set lock_timeout = '5s';
-- (or a value appropriate to your deployment window) in the same session
-- immediately before this file. The LOCK TABLE statement below blocks
-- every concurrent learning_sessions INSERT/UPDATE/DELETE for as long as
-- it takes this migration to run; without a lock_timeout, a lock request
-- that cannot be granted immediately queues (and, because Postgres grants
-- conflicting lock requests in arrival order, every ordinary query issued
-- after it queues up behind it too) for an unbounded time instead of
-- failing fast. A lock_timeout failure means retry during a lower-traffic
-- window, not raise the timeout without limit. Full procedure, exact
-- preflight/postflight queries, and rollback steps: see
-- supabase/PHASE1_RUNBOOK.md.
--
-- See .claude/video-learning-management-plan.md §8.15 / §12 / Phase 1.
-- =====================================================

begin;

-- SHARE mode conflicts with the ROW EXCLUSIVE lock every INSERT/UPDATE/
-- DELETE acquires, but not with ordinary ACCESS SHARE reads -- so existing
-- SELECT-based routes are not blocked, only writers are, for the duration
-- of this transaction. Held from here, BEFORE the reconciliation UPDATE,
-- through the CREATE UNIQUE INDEX at the end of this transaction: this is
-- what makes "decide survivors" and "enforce uniqueness" atomic against a
-- concurrent writer, not just each step individually locked. (A
-- non-concurrent CREATE UNIQUE INDEX would acquire this same SHARE lock on
-- its own -- taking it explicitly here just extends that same lock scope
-- backward to also cover the reconciliation UPDATE.)
lock table learning_sessions in share mode;

create table if not exists migration_030_abandoned_rounds_log (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null,
  user_id uuid null,
  youtube_video_id text not null,
  previous_status text not null,
  survivor_round_id uuid not null,
  changed_at timestamptz not null default now()
);

comment on table migration_030_abandoned_rounds_log is
  'Audit log for the one-time duplicate-active-round reconciliation this '
  'migration performs -- what changed, from what status, and which round '
  'survived as the sole active one. Protected: no ordinary client access '
  '(see GRANTs below). Restoring a row''s previous_status requires first '
  'dropping learning_sessions_one_active_per_video -- see this file''s '
  'footer comment and supabase/PHASE1_RUNBOOK.md for the full, ordered '
  'rollback; a naive UPDATE while the index still exists fails outright.';

-- Reconciliation. Survivor selection is deterministic: most recent
-- activity first (updated_at desc), with two further tie-breakers
-- (started_at desc, then id desc) so the choice never depends on
-- arbitrary row-return order when two rounds share the exact same
-- updated_at -- and deliberately NEVER by sentence index or score (a round
-- with a higher current_segment_index or accuracy is not necessarily the
-- one the user was most recently/actively working in).
--
-- `user_id is not null` is REQUIRED, not incidental: without it, every
-- anonymous active session for the same video (user_id is null, permitted
-- by the existing sessions_anon_insert policy) would be grouped into one
-- partition by this window function, since PARTITION BY groups NULLs
-- together -- incorrectly treating unrelated anonymous visitors' sessions
-- as one person's duplicate history and abandoning all but one of them.
-- Anonymous rows are therefore never touched by this reconciliation at
-- all, for however many exist per video. The unique index created below
-- does not restrict them either: a plain (non-partial-on-user_id) unique
-- index still treats every NULL user_id as distinct from every other NULL
-- for uniqueness purposes, so multiple anonymous active rows for the same
-- video remain valid afterward, exactly as today.
with ranked as (
  select
    id, user_id, youtube_video_id, status, updated_at,
    row_number() over (
      partition by user_id, youtube_video_id
      order by updated_at desc, started_at desc, id desc
    ) as rn
  from learning_sessions
  where status = 'active' and user_id is not null
),
survivors as (
  select user_id, youtube_video_id, id as survivor_round_id
  from ranked where rn = 1
),
losers as (
  select r.id as round_id, r.user_id, r.youtube_video_id, r.status as previous_status
  from ranked r
  where r.rn > 1
)
insert into migration_030_abandoned_rounds_log
  (round_id, user_id, youtube_video_id, previous_status, survivor_round_id)
select l.round_id, l.user_id, l.youtube_video_id, l.previous_status, s.survivor_round_id
from losers l
join survivors s
  on s.user_id = l.user_id and s.youtube_video_id = l.youtube_video_id;

-- Preserves round id, attempts, transcript pin, score, and every other
-- column on the abandoned rows -- only status and updated_at change.
update learning_sessions
set status = 'abandoned', updated_at = now()
where id in (select round_id from migration_030_abandoned_rounds_log);

-- Enforced AFTER the reconciliation above, inside the SAME locked
-- transaction, so the two steps are atomic: either both the status
-- changes and the index exist together when this transaction commits, or
-- (on any failure -- including an unexpected residual duplicate this
-- migration's own logic did not anticipate) neither does, and the audit
-- log rows inserted above are rolled back along with the status changes.
-- Non-concurrent CREATE UNIQUE INDEX is deliberate, not an oversight --
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block at all,
-- and this migration specifically needs the stronger, transaction-scoped
-- lock (above) held continuously from before the reconciliation UPDATE
-- through this statement, which CONCURRENTLY's weaker locking would not
-- provide.
create unique index if not exists learning_sessions_one_active_per_video
  on learning_sessions(user_id, youtube_video_id) where status = 'active';

alter table migration_030_abandoned_rounds_log enable row level security;
-- No permissive policy for anon/authenticated at all -- this audit log is
-- for operator/service-role inspection only (§4: "the migration
-- reconciliation audit log: no ordinary client access").
revoke all on migration_030_abandoned_rounds_log from public, anon, authenticated;
grant select on migration_030_abandoned_rounds_log to service_role;

commit;

-- ---------------------------------------------------------------------
-- ROLLBACK (do not run automatically; not consequence-free -- see
-- supabase/PHASE1_RUNBOOK.md for the full discussion):
--   1. drop index learning_sessions_one_active_per_video;
--   2. update learning_sessions set status = 'active'
--        where id in (select round_id from migration_030_abandoned_rounds_log);
-- Step 1 MUST run before step 2 -- restoring more than one active row per
-- (user_id, youtube_video_id) while the unique index still exists violates
-- it outright. This restores the status flag to what it was before this
-- migration ran; it does NOT undo anything that happened BECAUSE the
-- survivor was treated as the sole active round in the meantime (e.g. new
-- attempts recorded against it). Once any later phase has shipped and
-- relies on round uniqueness, this rollback reintroduces the exact
-- ambiguity this migration existed to remove -- treat it as safe only
-- before that point, not as a casually reversible step afterward.
-- ---------------------------------------------------------------------
