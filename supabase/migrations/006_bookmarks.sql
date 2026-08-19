-- Bookmarks: let users bookmark a video segment for later, independent of vocabulary capture.

create table if not exists bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  video_id text not null,
  segment_index integer not null,
  start_sec numeric not null,
  sentence_text text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists bookmarks_user_created_idx
  on bookmarks(user_id, created_at desc);

create unique index if not exists bookmarks_dedupe_idx
  on bookmarks(user_id, video_id, segment_index);

alter table bookmarks enable row level security;

create policy "bookmarks_owner_select"
  on bookmarks
  for select
  using (auth.uid() = user_id);

create policy "bookmarks_owner_insert"
  on bookmarks
  for insert
  with check (auth.uid() = user_id);

create policy "bookmarks_owner_update"
  on bookmarks
  for update
  using (auth.uid() = user_id);

create policy "bookmarks_owner_delete"
  on bookmarks
  for delete
  using (auth.uid() = user_id);
