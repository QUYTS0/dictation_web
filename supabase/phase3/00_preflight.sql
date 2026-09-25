-- Phase 3 — READ-ONLY preflight. Safe to run at any time, as often as you like.
-- Run in the Supabase SQL editor (role: postgres). Changes nothing.

-- 1. Migration 037 installed, stage machine present.
select fn_phase3_status() as status;

-- 2. ICU collation required by grading parity (037 refuses to install without it).
select collname from pg_collation where collname = 'und-x-icu';

-- 3. Gate row (must exist; before step 3: paused = false, both Phase 3 flags false).
select * from app_write_gate;

-- 4. learning_sessions policies (before step 2: sessions_owner + sessions_anon_insert present).
select policyname, cmd, roles from pg_policies where schemaname = 'public' and tablename = 'learning_sessions' order by 1;

-- 5. Table privileges that step 2 changes.
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('learning_sessions', 'attempt_logs')
  and grantee in ('anon', 'authenticated', 'service_role')
group by 1, 2 order by 1, 2;

-- 6. The backfill refuses to run if user triggers exist on these tables (they
--    could rewrite updated_at/completed_at). Expect zero rows.
select tgrelid::regclass as table_name, tgname
from pg_trigger
where not tgisinternal and tgrelid in ('public.learning_sessions'::regclass, 'public.attempt_logs'::regclass);

-- 7. Expected backfill cohort size and anomalies (what fn_phase3_backfill will report).
select count(*) as rounds_to_classify,
       count(*) filter (where status = 'completed' and completed_at is null) as completed_without_time,
       count(*) filter (where user_id is null) as anonymous_rows,
       count(*) filter (where transcript_id is null) as no_transcript_pin,
       count(*) filter (where updated_at < started_at) as updated_before_started,
       count(*) filter (where started_at > now()) as started_in_future
from learning_sessions where provenance = 'current';
select count(*) as attempts_to_classify from attempt_logs where segment_identity_provenance = 'verified';

-- 8. One active round per (user, video) — the authoritative functions rely on it.
select user_id, youtube_video_id, count(*) from learning_sessions
where status = 'active' and user_id is not null
group by 1, 2 having count(*) > 1;
