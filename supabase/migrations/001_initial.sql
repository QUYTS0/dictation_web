-- =====================================================
-- English Dictation Trainer — Initial Database Schema
-- Run in Supabase SQL Editor (or via supabase db push)
-- =====================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- -------------------------------------------------------
-- Table: videos
-- -------------------------------------------------------
create table if not exists videos (
  id               uuid primary key default uuid_generate_v4(),
  youtube_video_id text not null unique,
  title            text,
  language         text not null default 'en',
  duration_sec     numeric,
  created_at       timestamptz not null default now()
);

-- -------------------------------------------------------
-- Table: transcripts
-- -------------------------------------------------------
create table if not exists transcripts (
  id               uuid primary key default uuid_generate_v4(),
  youtube_video_id text not null references videos(youtube_video_id) on delete cascade,
  language         text not null default 'en',
  source           text not null check (source in ('cache', 'ai', 'manual')),
  status           text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  version          integer not null default 1,
  full_text        text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists transcripts_video_id_idx on transcripts(youtube_video_id);
create index if not exists transcripts_status_idx   on transcripts(status);

-- -------------------------------------------------------
-- Table: transcript_segments
-- -------------------------------------------------------
create table if not exists transcript_segments (
  id               uuid primary key default uuid_generate_v4(),
  transcript_id    uuid not null references transcripts(id) on delete cascade,
  segment_index    integer not null,
  start_sec        numeric not null,
  end_sec          numeric not null,
  duration_sec     numeric not null,
  text_raw         text not null,
  text_normalized  text not null,
  unique (transcript_id, segment_index)
);

create index if not exists segments_transcript_idx on transcript_segments(transcript_id);
create index if not exists segments_start_idx       on transcript_segments(start_sec);

-- -------------------------------------------------------
-- Table: users  (mirrors auth.users via trigger)
-- -------------------------------------------------------
create table if not exists users (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  created_at   timestamptz not null default now()
);

-- Trigger: auto-insert profile on sign-up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.users (id, email, display_name)
  values (new.id, new.email, new.raw_user_meta_data->>'display_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- -------------------------------------------------------
-- Table: learning_sessions
-- -------------------------------------------------------
create table if not exists learning_sessions (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid references users(id) on delete set null,
  youtube_video_id      text not null,
  transcript_id         uuid references transcripts(id) on delete set null,
  current_segment_index integer not null default 0,
  accuracy              numeric not null default 0,
  total_attempts        integer not null default 0,
  status                text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  started_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists sessions_user_idx    on learning_sessions(user_id);
create index if not exists sessions_video_idx   on learning_sessions(youtube_video_id);

-- -------------------------------------------------------
-- Table: attempt_logs
-- -------------------------------------------------------
create table if not exists attempt_logs (
  id             uuid primary key default uuid_generate_v4(),
  session_id     uuid not null references learning_sessions(id) on delete cascade,
  segment_index  integer not null,
  expected_text  text not null,
  user_text      text not null,
  is_correct     boolean not null default false,
  error_type     text,
  created_at     timestamptz not null default now()
);

create index if not exists attempts_session_idx on attempt_logs(session_id);

-- -------------------------------------------------------
-- Table: ai_feedback
-- -------------------------------------------------------
create table if not exists ai_feedback (
  id              uuid primary key default uuid_generate_v4(),
  attempt_id      uuid references attempt_logs(id) on delete cascade,
  explanation     text,
  corrected_text  text,
  example_text    text,
  created_at      timestamptz not null default now()
);

-- -------------------------------------------------------
-- Row Level Security
-- -------------------------------------------------------
alter table videos             enable row level security;
alter table transcripts        enable row level security;
alter table transcript_segments enable row level security;
alter table users              enable row level security;
alter table learning_sessions  enable row level security;
alter table attempt_logs       enable row level security;
alter table ai_feedback        enable row level security;

-- videos / transcripts / segments — readable by everyone
create policy "videos_public_read"              on videos              for select using (true);
create policy "transcripts_public_read"         on transcripts         for select using (true);
create policy "transcript_segments_public_read" on transcript_segments for select using (true);

-- service-role can manage transcripts (used by server-side API)
create policy "transcripts_service_manage"         on transcripts         for all using (auth.role() = 'service_role');
create policy "transcript_segments_service_manage" on transcript_segments for all using (auth.role() = 'service_role');
create policy "videos_service_manage"              on videos              for all using (auth.role() = 'service_role');

-- users — each user reads/updates their own profile
create policy "users_self_read"   on users for select using (auth.uid() = id);
create policy "users_self_update" on users for update using (auth.uid() = id);

-- learning_sessions — owner access
create policy "sessions_owner"      on learning_sessions for all using (auth.uid() = user_id);
create policy "sessions_anon_insert" on learning_sessions for insert with check (user_id is null);

-- attempt_logs — readable by session owner
create policy "attempts_owner" on attempt_logs for all
  using (session_id in (select id from learning_sessions where user_id = auth.uid()));

-- ai_feedback — readable by attempt owner (via join)
create policy "ai_feedback_owner" on ai_feedback for select
  using (attempt_id in (
    select al.id from attempt_logs al
    join learning_sessions ls on ls.id = al.session_id
    where ls.user_id = auth.uid()
  ));
create policy "ai_feedback_service_manage" on ai_feedback for all using (auth.role() = 'service_role');
