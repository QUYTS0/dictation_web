-- Spaced-repetition scheduling fields for vocabulary review mode.

alter table if exists vocabulary_items
  add column if not exists next_review_at timestamptz not null default now(),
  add column if not exists interval_days numeric not null default 0,
  add column if not exists ease_factor numeric not null default 2.5,
  add column if not exists repetitions integer not null default 0,
  add column if not exists last_reviewed_at timestamptz;

create index if not exists vocabulary_items_review_idx
  on vocabulary_items(user_id, next_review_at);
