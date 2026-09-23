-- =====================================================
-- Phase 1 — study_sessions
--
-- A study session is a bounded span of engaged activity on one video,
-- independent of a Practice Round: round_id is nullable so a Listening-only
-- session (no Dictation/Shadowing round at all) can exist on its own.
-- Nothing in this repository wires study_sessions into the player,
-- practice hooks, Dashboard, or History yet -- this migration only creates
-- the table. Creation/resume/force-close and activity-interval writes are
-- SECURITY DEFINER-only (fn_get_or_create_study_session /
-- fn_flush_study_activity, Phase 2) so a direct client write can never
-- fabricate activity_intervals or bypass the force-close-on-new-round rule.
--
-- See .claude/video-learning-management-plan.md §8.5 / §9.9 / Phase 1.
-- =====================================================

create table if not exists study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  round_id uuid null references learning_sessions(id) on delete set null,
  youtube_video_id text not null,
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at timestamptz null,
  modes_used jsonb not null default '[]'::jsonb,
  activity_intervals jsonb not null default '[]'::jsonb,
  listening_observed_sec numeric not null default 0,
  listening_newly_covered_sec numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists study_sessions_round_idx on study_sessions(round_id);
create index if not exists study_sessions_user_recent_idx on study_sessions(user_id, last_activity_at desc);

comment on table study_sessions is
  'A bounded span of engaged activity on one video. round_id is nullable '
  '-- a Listening-only session needs no Practice Round. Not wired into any '
  'route/UI yet (Phase 1 is schema-only); see '
  '.claude/video-learning-management-plan.md §5.3.';
comment on column study_sessions.round_id is
  'Nullable: a Listening-only study session has no Practice Round. Set '
  'once at creation (possibly null) -- a session''s round_id is never '
  'repointed after creation; starting another round force-closes the '
  'current session and opens a new one instead (§5.3 rule 4).';
comment on column study_sessions.activity_intervals is
  'Wall-clock timestamps of engaged activity, merged only on true overlap/'
  'touching -- never on a tolerance window (§6.3b). Written only by '
  'fn_flush_study_activity (Phase 2); empty by construction until then.';

alter table study_sessions enable row level security;

-- Owner SELECT only (R28) -- writes are reachable only through
-- fn_get_or_create_study_session / fn_flush_study_activity (SECURITY
-- DEFINER, Phase 2), which bypass RLS as the table owner after their own
-- auth.uid()-based checks. A direct client INSERT/UPDATE here would bypass
-- the advisory-locked force-close logic and let activity_intervals be
-- fabricated directly, inflating the practice-time stat with no
-- server-side check at all -- so no owner-write policy is defined.
create policy "study_sessions_owner_select" on study_sessions
  for select using (auth.uid() = user_id);

-- Explicit privileges (Supabase's restricted-default-grants change,
-- §4/§9.9): a fresh project created under the new default-privilege regime
-- grants nothing automatically to anon/authenticated on a newly created
-- table, so the SELECT policy above would be silently unreachable
-- ("permission denied for table study_sessions") without this GRANT. On an
-- older project that still auto-grants broadly to anon/authenticated, the
-- REVOKE below removes anything that would otherwise contradict "ordinary
-- clients cannot directly insert, update, or delete" -- RLS alone already
-- blocks those commands (no policy permits them), but the table-level
-- privilege is revoked too so the access model is correct at both layers,
-- not just enforced redundantly by RLS.
revoke all on study_sessions from public, anon, authenticated;
grant select on study_sessions to authenticated;
-- service_role: no direct table privilege granted here. Every write path
-- in this plan for study_sessions goes through a SECURITY DEFINER function
-- owned by the table-owning migration role (effectively `postgres`), which
-- bypasses both RLS and the ordinary GRANT check for that role -- not
-- because service_role itself holds a grant. Nothing in Phase 1 or the
-- documented Phase 2 functions calls study_sessions directly as
-- service_role, so none is added speculatively here.
