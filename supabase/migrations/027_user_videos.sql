-- =====================================================
-- Phase 1 — user_videos
--
-- Library membership: "this video is in this user's library", including
-- states no derived-only query could represent ("added, not started",
-- "Listening-only, no round"). Deliberately NEVER authoritative for
-- coverage/completion/scores -- every such read still goes to
-- learning_sessions/attempt_logs/shadowing_attempts/listening_progress.
--
-- The one new table in this plan that keeps owner `for all` RLS rather
-- than narrowing to SELECT-only: no column here feeds coverage/completion/
-- scores, so there is nothing for a client to gain by writing it directly
-- beyond cosmetic self-inconvenience (a wrong last_mode badge, a stale
-- resume hint).
--
-- See .claude/video-learning-management-plan.md §8.9 / §9.9 / Phase 1.
-- =====================================================

create table if not exists user_videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  youtube_video_id text not null,
  added_at timestamptz not null default now(),
  last_mode text null check (last_mode in ('dictation', 'listening', 'shadowing')),
  last_active_round_id uuid null references learning_sessions(id) on delete set null,
  last_resume_segment_index integer null,
  last_activity_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_videos_identity_idx on user_videos(user_id, youtube_video_id);
create index if not exists user_videos_user_recent_idx on user_videos(user_id, last_activity_at desc);

comment on table user_videos is
  'Library membership only -- never authoritative for coverage/completion/'
  'scores (those always come from learning_sessions/attempt_logs/'
  'shadowing_attempts/listening_progress). Exists to represent "added, not '
  'started" and to anchor the Library query. Not wired into any route/UI '
  'yet (Phase 1 is schema-only). See '
  '.claude/video-learning-management-plan.md §5.6/§8.9.';

alter table user_videos enable row level security;
create policy "user_videos_owner" on user_videos for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Explicit privileges (§4/§9.9 -- see 023_study_sessions.sql's comment for
-- the full old-vs-new-default-grants rationale). Owner CRUD, matching the
-- `for all` RLS policy above -- a policy alone does not supply the
-- underlying table privilege.
revoke all on user_videos from public, anon, authenticated;
grant select, insert, update, delete on user_videos to authenticated;

-- Backfill membership from every (user, video) with existing evidence in
-- EITHER legacy source -- reliable, not invented. Corrected from the
-- plan's original two separately-grouped-then-UNIONed queries (§5 of the
-- Phase 1 task spec): that shape discards a source's timestamps for any
-- (user, video) pair present in both learning_sessions and
-- listening_sessions, because whichever source's grouped row happened to
-- be processed first by ON CONFLICT DO NOTHING silently "won" the whole
-- row. Instead: combine both sources row-wise first (UNION ALL, not
-- UNION -- every row must survive into the aggregation, not be
-- deduplicated away before it can be aggregated), then aggregate once per
-- (user_id, youtube_video_id) so `added_at` is genuinely the earliest
-- timestamp and `last_activity_at` genuinely the latest, across both
-- sources together, never decided by arbitrary source ordering.
insert into user_videos (user_id, youtube_video_id, added_at, last_activity_at)
select
  user_id,
  youtube_video_id,
  min(started_at) as added_at,
  max(last_activity_at) as last_activity_at
from (
  select user_id, youtube_video_id, started_at, updated_at as last_activity_at
  from learning_sessions
  where user_id is not null
  union all
  select user_id, youtube_video_id, started_at, updated_at as last_activity_at
  from listening_sessions
  where user_id is not null
) combined_evidence
group by user_id, youtube_video_id
on conflict (user_id, youtube_video_id) do nothing;
