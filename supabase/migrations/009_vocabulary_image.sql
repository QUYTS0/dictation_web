-- Free illustrative photo (via Openverse) for saved single-word vocabulary
-- items.

alter table vocabulary_items add column if not exists image_url text;
alter table vocabulary_items add column if not exists image_thumbnail_url text;
alter table vocabulary_items add column if not exists image_attribution text;
alter table vocabulary_items add column if not exists image_source_url text;
