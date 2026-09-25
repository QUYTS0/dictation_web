-- =====================================================
-- Phase 1 — listening_progress
--
-- Revision-scoped Listening coverage, replacing the dead-but-not-forgotten
-- listening_sessions table (which only ever recorded a raw playhead
-- position, never real intervals). Two partial unique indexes, not one
-- plain unique index -- a plain unique index would treat every NULL
-- transcript_id as distinct, silently allowing multiple rows for a video
-- with no transcript yet.
--
-- See .claude/video-learning-management-plan.md §8.8 / Phase 1.
-- =====================================================

create table if not exists listening_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  youtube_video_id text not null,
  transcript_id uuid null references transcripts(id) on delete set null,
  covered_intervals jsonb not null default '[]'::jsonb,
  covered_sec numeric not null default 0,
  transcript_covered_sec numeric null,
  coverage_ratio numeric not null default 0,
  listened_through boolean not null default false,
  listened_through_at timestamptz null,
  last_position_sec numeric not null default 0,
  last_synced_at timestamptz not null default now(),
  legacy_source text null,
  superseded_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists listening_progress_identity_with_transcript_idx
  on listening_progress(user_id, youtube_video_id, transcript_id) where transcript_id is not null;
create unique index if not exists listening_progress_identity_no_transcript_idx
  on listening_progress(user_id, youtube_video_id) where transcript_id is null;
create index if not exists listening_progress_user_idx on listening_progress(user_id);

comment on table listening_progress is
  'Revision-scoped Listening coverage. covered_intervals is exact, real '
  'observed-position data -- never inferred from a lone playhead position. '
  'Not wired into any route/UI yet (Phase 1 is schema-only). See '
  '.claude/video-learning-management-plan.md §6.3/§8.8.';
comment on column listening_progress.legacy_source is
  'Set to ''legacy_listening_sessions'' on rows created by this '
  'migration''s backfill, distinguishing best-effort imported '
  'position-only data from genuinely observed intervals. Never treated as '
  'verified coverage.';

alter table listening_progress enable row level security;
-- Owner SELECT only (R28) -- covered_intervals/covered_sec/coverage_ratio
-- are coverage data, not UI convenience; writes (including the
-- null-transcript transition, §8.8) are reachable only via
-- fn_flush_study_activity's listening kind (Phase 2), which bypasses RLS
-- as SECURITY DEFINER after its own auth.uid()/relationship checks.
create policy "listening_progress_owner_select" on listening_progress
  for select using (auth.uid() = user_id);

-- Explicit privileges (§4/§9.9 -- see 023_study_sessions.sql's comment for
-- the full old-vs-new-default-grants rationale, applied identically here).
revoke all on listening_progress from public, anon, authenticated;
grant select on listening_progress to authenticated;
-- service_role: no direct table privilege granted. No documented write
-- path in this plan uses the service-role client against
-- listening_progress directly (writes go through a SECURITY DEFINER
-- function, which needs no grant of its own -- see 023's comment).

-- Backfill from the dead-but-not-forgotten listening_sessions table. This
-- is a best-effort, explicitly-provenanced import -- NOT a claim of
-- verified coverage. covered_intervals stays empty (an empty JSON array,
-- its column default); only the last-known position carries over, purely
-- for resume convenience. Deterministic source-row selection: `updated_at
-- desc, id desc` -- the trailing `id desc` is a stable tie-breaker for the
-- (rare, but possible) case of two legacy rows sharing the exact same
-- updated_at timestamp, so this backfill's result does not depend on
-- whatever arbitrary row order Postgres happens to return them in.
insert into listening_progress
  (user_id, youtube_video_id, transcript_id, last_position_sec, legacy_source, updated_at)
select distinct on (user_id, youtube_video_id, transcript_id)
  user_id, youtube_video_id, transcript_id, video_current_time, 'legacy_listening_sessions', updated_at
from listening_sessions
where user_id is not null
order by user_id, youtube_video_id, transcript_id, updated_at desc, id desc
on conflict do nothing;

comment on table listening_sessions is
  'Deprecated: superseded by listening_progress. No longer written to by '
  'the app (it was already dead code before this migration). Kept, not '
  'dropped, for historical provenance.';
