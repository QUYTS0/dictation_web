-- =====================================================
-- Phase 1 — Practice round columns on learning_sessions
--
-- learning_sessions becomes the "Practice Round" entity: one pass through a
-- video's sentence set, fixed to one transcript_id, that may span multiple
-- study_sessions (023) and both Dictation and Shadowing modes. This
-- migration only extends the existing table -- the table name, its
-- existing columns, and its existing RLS policies are all left exactly as
-- they are today (learning_sessions' RLS is deliberately NOT touched until
-- the Phase 3 cutover, since save-progress/route.ts and session/restart/
-- route.ts still write through it using the caller's own RLS-respecting
-- client and depend on its current, permissive policies).
--
-- See .claude/video-learning-management-plan.md §8.4 / Phase 1.
-- =====================================================

alter table learning_sessions
  add column if not exists round_number integer not null default 1,
  add column if not exists completed_at timestamptz null,
  add column if not exists required_sentence_count integer null,
  add column if not exists provenance text not null default 'current'
    check (provenance in ('current', 'legacy_unverified'));

comment on table learning_sessions is
  'Practice Round: one pass through a video''s sentence set, fixed to one '
  'transcript_id. May span multiple study_sessions and both Dictation and '
  'Shadowing modes. Table name kept for compatibility; see '
  '.claude/video-learning-management-plan.md §5.';

comment on column learning_sessions.round_number is
  'Which attempt-numbered pass through this video this round represents '
  'for this user (1 = first). Defaults to 1 for both new rows and every '
  'pre-existing row -- no historical round-number sequence is reconstructed '
  'by this migration.';

comment on column learning_sessions.completed_at is
  'When this round transitioned to status=''completed''. Null for rounds '
  'that are still active/abandoned, and for every pre-existing completed '
  'row (its actual completion time is not recoverable from history and is '
  'not backfilled/guessed here).';

comment on column learning_sessions.required_sentence_count is
  'The sentence count this round needed to reach completion, captured at '
  'round-creation time. Null for every pre-existing row (Phase 1 does not '
  'retroactively compute this for historical rounds -- see the plan''s '
  '"do not calculate historical completion" constraint).';

comment on column learning_sessions.provenance is
  'Schema default only in this migration -- every row (new and '
  'pre-existing) reads ''current'' until migration 034 runs. The actual '
  'retroactive ''legacy_unverified'' tagging of pre-existing rows is NOT '
  'part of Phase 1; it is deliberately deferred to migration '
  '034_provenance_backfill_and_completion_cutover.sql (Phase 3), run '
  'together with the write-gate/cutover runbook, not as a bare migration '
  'apply. (Corrects a stale "migration 033" cross-reference that appeared '
  'in an earlier draft of §8.4 of the plan -- the provenance backfill has '
  'always meant this migration, 034, in the current phase numbering.) '
  'Until 034 runs, a ''current'' value on a pre-existing row is NOT a claim '
  'that the row has been verified -- it is simply the column''s default, '
  'unset for legacy data.';
