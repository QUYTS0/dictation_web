-- =====================================================
-- Deterministic vocab-highlight pipeline — extends the existing
-- transcript_vocab_highlights cache in place (rather than creating a new
-- table) so transcript/generate's existing wholesale delete-by-transcript_id
-- on regeneration (which is shape-agnostic) needs no changes.
--
-- Cache identity: (transcript_id, segment_index, learning_level,
-- pipeline_version) is the sole key that gates a cache hit/upsert conflict.
-- transcript_text_hash is a stored validity marker checked at read time
-- (application code), not part of the unique constraint — see cache.ts.
-- dataset_versions is intentionally NOT a column here: it lives only in
-- src/lib/vocabHighlights/data/manifest.json for observability, and does
-- NOT independently gate the cache (only pipeline_version does).
-- =====================================================

alter table transcript_vocab_highlights
  add column if not exists learning_level      text,
  add column if not exists pipeline_version    text not null default 'gemini-legacy-v1',
  add column if not exists transcript_text_hash text,
  add column if not exists status              text not null default 'complete'
                             check (status in ('complete', 'empty')),
  add column if not exists azure_used          boolean not null default false,
  add column if not exists candidate_counts    jsonb not null default '{}'::jsonb,
  add column if not exists generated_at        timestamptz not null default now();

-- Backfill existing Gemini-era rows: learning_level matches the old
-- hardcoded "intermediate (B1-B2)" prompt; transcript_text_hash stays null
-- (unknown for legacy rows), which correctly makes them fail the read-time
-- hash check even if somehow selected — see cache.ts's readCachedHighlights.
update transcript_vocab_highlights
  set learning_level = 'B1'
  where learning_level is null;

alter table transcript_vocab_highlights
  alter column learning_level set not null,
  alter column learning_level set default 'B1';

-- The (transcript_id, segment_index) unique constraint was declared inline
-- (`unique (transcript_id, segment_index)`) in 011_vocab_highlights.sql
-- without an explicit name, so Postgres auto-named it using its standard
-- <table>_<col1>_<col2>_key convention.
alter table transcript_vocab_highlights
  drop constraint if exists transcript_vocab_highlights_transcript_id_segment_index_key,
  add constraint transcript_vocab_highlights_unique
    unique (transcript_id, segment_index, learning_level, pipeline_version);
