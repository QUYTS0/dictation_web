-- Vocabulary word/phrase/sentence translation now uses Azure Translator
-- instead of the unofficial Google Translate library. Widen the existing
-- check constraint to allow 'azure' going forward while keeping
-- 'free_library' so historical vocabulary_items rows stay valid.

alter table vocabulary_items drop constraint if exists vocabulary_items_translation_source_check;
alter table vocabulary_items add constraint vocabulary_items_translation_source_check
  check (translation_source in ('free_library', 'gemini', 'azure'));
