-- =====================================================
-- Dictation Script tab — AI-picked vocab highlight cache
-- One row per transcript segment; phrases is a JSON array of exact
-- substrings of that segment's text worth a learner's attention. Cached
-- exactly like transcript_translations (004) so a given transcript only
-- ever costs one Gemini call, shared by every future viewer.
-- =====================================================

create table if not exists transcript_vocab_highlights (
  id             uuid primary key default gen_random_uuid(),
  transcript_id  uuid not null references transcripts(id) on delete cascade,
  segment_index  integer not null,
  phrases        jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  unique (transcript_id, segment_index)
);

create index if not exists vocab_highlights_transcript_idx on transcript_vocab_highlights(transcript_id);

alter table transcript_vocab_highlights enable row level security;

create policy "transcript_vocab_highlights_public_read" on transcript_vocab_highlights for select using (true);
create policy "transcript_vocab_highlights_service_manage" on transcript_vocab_highlights for all using (auth.role() = 'service_role');
