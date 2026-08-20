-- Auto-translation for saved vocabulary items (word/phrase/sentence), so the
-- user doesn't have to look up and type a translation by hand when saving.

alter table vocabulary_items add column if not exists translation text;
alter table vocabulary_items add column if not exists translation_language text not null default 'vi';
alter table vocabulary_items add column if not exists translation_source text check (translation_source in ('free_library', 'gemini'));
