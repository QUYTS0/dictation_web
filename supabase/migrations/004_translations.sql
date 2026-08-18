-- =====================================================
-- Listening Practice — Vietnamese translation cache
-- =====================================================

create table if not exists transcript_translations (
  id              uuid primary key default gen_random_uuid(),
  transcript_id   uuid not null references transcripts(id) on delete cascade,
  segment_index   integer not null,
  language        text not null default 'vi',
  text_translated text not null,
  source          text not null check (source in ('youtube_captions', 'free_library', 'gemini')),
  created_at      timestamptz not null default now(),
  unique (transcript_id, segment_index, language)
);

create index if not exists translations_transcript_idx on transcript_translations(transcript_id);

alter table transcript_translations enable row level security;

create policy "transcript_translations_public_read" on transcript_translations for select using (true);
create policy "transcript_translations_service_manage" on transcript_translations for all using (auth.role() = 'service_role');
