-- =====================================================
-- Listening mode session tracking
-- Kept as its own table rather than folding into learning_sessions:
-- listening has no grading/attempts concept (no attempt_logs equivalent),
-- just a watch position — reusing learning_sessions would mean either a
-- pile of nullable dictation-only columns or a mode discriminator mixed
-- into an otherwise dictation-shaped table. History/Dashboard queries
-- union this table with learning_sessions and tag each row with its mode.
-- =====================================================

create table if not exists listening_sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references users(id) on delete set null,
  youtube_video_id   text not null,
  transcript_id      uuid references transcripts(id) on delete set null,
  video_current_time numeric not null default 0,
  status             text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  started_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists listening_sessions_user_idx  on listening_sessions(user_id);
create index if not exists listening_sessions_video_idx on listening_sessions(youtube_video_id);

alter table listening_sessions enable row level security;

create policy "listening_sessions_owner" on listening_sessions for all using (auth.uid() = user_id);
