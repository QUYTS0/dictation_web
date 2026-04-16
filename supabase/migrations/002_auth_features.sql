-- Auth-required learning features: autosave/resume, vocabulary, dashboard fields

alter table if exists learning_sessions
  add column if not exists active_segment_index integer not null default 0,
  add column if not exists video_current_time numeric not null default 0,
  add column if not exists attempt_count integer not null default 0;

update learning_sessions
set
  active_segment_index = current_segment_index,
  attempt_count = total_attempts
where
  (active_segment_index = 0 and current_segment_index <> 0)
  or (attempt_count = 0 and total_attempts <> 0);

alter table if exists attempt_logs
  add column if not exists normalized_expected_text text,
  add column if not exists normalized_user_text text;

create table if not exists vocabulary_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  video_id text not null,
  segment_index integer not null,
  term text not null,
  normalized_term text not null,
  sentence_context text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists vocabulary_items_user_created_idx
  on vocabulary_items(user_id, created_at desc);

create unique index if not exists vocabulary_items_dedupe_idx
  on vocabulary_items(user_id, video_id, segment_index, normalized_term);

alter table vocabulary_items enable row level security;

create policy "vocabulary_owner_select"
  on vocabulary_items
  for select
  using (auth.uid() = user_id);

create policy "vocabulary_owner_insert"
  on vocabulary_items
  for insert
  with check (auth.uid() = user_id);

create policy "vocabulary_owner_update"
  on vocabulary_items
  for update
  using (auth.uid() = user_id);

create policy "vocabulary_owner_delete"
  on vocabulary_items
  for delete
  using (auth.uid() = user_id);
