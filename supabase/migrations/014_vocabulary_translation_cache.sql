-- =====================================================
-- Shared Azure Translator cache for vocabulary word/phrase/sentence
-- lookups (popover preview + save). Distinct from transcript_translations,
-- which caches whole-segment transcript translations keyed by
-- transcript_id — this cache is global, keyed only by the normalized input
-- text, so the same word/phrase looked up by any user on any video is
-- served from one shared row instead of spending Azure quota again.
-- =====================================================

create table if not exists vocabulary_translation_cache (
  id              uuid primary key default gen_random_uuid(),
  source_language text not null,
  target_language text not null,
  selection_type  text not null check (selection_type in ('word', 'phrase', 'sentence')),
  normalized_text text not null,
  translation     text not null,
  provider        text not null default 'azure' check (provider in ('azure')),
  metadata        jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (source_language, target_language, selection_type, normalized_text)
);

alter table vocabulary_translation_cache enable row level security;

-- Same shape as transcript_translations: readable by anyone (it's a
-- non-sensitive, shared cache of dictionary/translation results), written
-- only by server-side code using the service-role key.
create policy "vocabulary_translation_cache_public_read" on vocabulary_translation_cache for select using (true);
create policy "vocabulary_translation_cache_service_manage" on vocabulary_translation_cache for all using (auth.role() = 'service_role');
