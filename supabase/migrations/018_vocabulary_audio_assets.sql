-- Azure TTS audio cache for saved vocabulary pronunciation. Purely
-- additive: a new table plus one nullable FK column on vocabulary_items.
-- The existing `audio_url` column (dictionary pass-through, single words
-- only) is untouched — this table only ever backs on-demand Azure
-- synthesis, for words with no dictionary audio and for phrases (which
-- never get dictionary audio at all).
--
-- Modeled directly on vocabulary_translation_cache (014): public-read /
-- service-role-write RLS, unique constraint on the normalized identity,
-- upsert-on-conflict writes. Content-addressed and global (not scoped per
-- user) so the same pronunciation of the same text/voice is generated once
-- and reused by every saved item that needs it.
create table if not exists vocabulary_audio_assets (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null default 'azure_tts' check (provider in ('azure_tts')),
  -- The exact text actually sent to synthesis (the verified displayed
  -- term/phrase) — never lowercased or otherwise reshaped beyond trim +
  -- internal-whitespace collapse + Unicode NFC, so case/punctuation that
  -- changes pronunciation is never silently merged with a different input.
  text              text not null,
  normalized_text   text not null,
  voice             text not null,          -- e.g. 'en-US-JennyNeural'
  locale            text not null,          -- e.g. 'en-US'
  output_format     text not null,          -- e.g. 'audio-24khz-48kbitrate-mono-mp3'
  synthesis_version text not null,          -- app-defined; bump to force regeneration
  storage_path      text not null,          -- Supabase Storage object path (bucket: vocabulary-audio)
  char_count        integer not null,       -- for accounting/debug, not billing truth
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz not null default now(),
  unique (voice, locale, output_format, synthesis_version, normalized_text)
);

alter table vocabulary_audio_assets enable row level security;
create policy "vocabulary_audio_assets_public_read"
  on vocabulary_audio_assets for select using (true);
create policy "vocabulary_audio_assets_service_manage"
  on vocabulary_audio_assets for all using (auth.role() = 'service_role');

alter table vocabulary_items
  add column pronunciation_audio_asset_id uuid null
    references vocabulary_audio_assets(id) on delete set null;

-- Public Storage bucket for the generated MP3s — a public URL never
-- expires, so no signed-URL refresh logic is needed anywhere the audio is
-- played back. Uploaded to only from server-side code using the
-- service-role key (see src/lib/vocabularyAudioCache.ts).
insert into storage.buckets (id, name, public)
values ('vocabulary-audio', 'vocabulary-audio', true)
on conflict (id) do nothing;

create policy "vocabulary_audio_public_read"
  on storage.objects for select
  using (bucket_id = 'vocabulary-audio');

create policy "vocabulary_audio_service_manage"
  on storage.objects for all
  using (bucket_id = 'vocabulary-audio' and auth.role() = 'service_role');
