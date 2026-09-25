-- =====================================================
-- Phase 0 — Transcript revision identity
-- Adds the columns needed to tell transcript revisions apart and to know
-- which one is "current" for a (youtube_video_id, language) pair, without
-- touching any existing row's id, segments, or references.
-- See .claude/video-learning-management-plan.md, Phase 0.
-- =====================================================

alter table transcripts
  add column if not exists content_fingerprint text null,
  add column if not exists is_current boolean not null default false,
  add column if not exists superseded_at timestamptz null;

-- At most one current revision per (video, language). Partial (not a plain
-- unique index) so any number of non-current rows can coexist — historical
-- revisions are never deleted or merged by this migration.
create unique index if not exists transcripts_one_current_idx
  on transcripts(youtube_video_id, language)
  where is_current;

comment on column transcripts.content_fingerprint is
  'Deterministic hash over normalized segment text + rounded timing (see '
  'src/lib/utils/transcriptFingerprint.ts). Null on every pre-Phase-0 row -- '
  'those legacy rows never participate in fingerprint-based reuse matching '
  '(a null fingerprint cannot equal another null fingerprint under the '
  'content_fingerprint = p_content_fingerprint comparison used by '
  'fn_publish_transcript_revision) until a separately justified backfill '
  'mechanism computes one for them. That backfill is not part of this '
  'migration and is not scheduled here.';

comment on column transcripts.is_current is
  'The revision a new round/session/reader should resolve for this '
  '(youtube_video_id, language) when no specific transcript_id is pinned. '
  'Decoupled from `version` -- the highest version is not assumed to always '
  'be current (see fn_publish_transcript_revision''s reuse-and-repromote '
  'branch).';

comment on column transcripts.superseded_at is
  'Stamped the moment a revision stops being is_current. Null for a '
  'revision that is current, or that was never promoted to current at all '
  '(e.g. an abandoned/failed generation).';

-- One-time backfill: promote exactly one 'ready' revision per (video,
-- language) to current. Tie-break matches the ordering the app's own
-- read/write paths already used before this migration (most recently
-- updated, then most recently created) -- deterministic and stable, not a
-- new rule invented for this backfill.
with ranked as (
  select
    id,
    row_number() over (
      partition by youtube_video_id, language
      order by updated_at desc, created_at desc
    ) as rn
  from transcripts
  where status = 'ready'
)
update transcripts
set is_current = true
where id in (select id from ranked where rn = 1);

-- Nothing else changes: existing transcript ids, transcript_segments rows,
-- learning_sessions.transcript_id references, and attempt_logs rows are all
-- left completely untouched by this migration.
