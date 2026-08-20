-- Oxford-style word details (pronunciation, part of speech, definition) for
-- saved single-word vocabulary items.

alter table vocabulary_items add column if not exists phonetic text;
alter table vocabulary_items add column if not exists part_of_speech text;
alter table vocabulary_items add column if not exists definition text;
alter table vocabulary_items add column if not exists definition_source text check (definition_source in ('free_dictionary', 'gemini'));
