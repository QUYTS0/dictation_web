-- Phase 6 — READ-ONLY preflight. Run BEFORE applying 040. Changes nothing.

-- 1. Prerequisites: Phase 3 activated, Phase 4 (038) and Phase 5 (039) applied.
select
  (select stage from phase3_cutover_state where id = 1) as phase3_stage,                                  -- expect 'activated'
  to_regprocedure('public.fn_shadowing_round_results(uuid)') is not null as phase4_applied,              -- expect true
  to_regprocedure('public.fn_sync_study_activity(text,uuid,text,uuid,jsonb,uuid,numeric,text,numeric)') is not null
    as phase5_applied,                                                                                     -- expect true
  to_regclass('public.activity_flush_log_batch_idx') is not null as phase5_batch_index;                   -- expect true

-- 2. 040 not applied yet (a re-run after 040 shows true — then use 01_postflight.sql).
select to_regprocedure('public.fn_video_library(integer,integer,text)') is not null as phase6_applied,
       to_regclass('public.user_video_removals') is not null as removals_table_present;

-- 3. Library membership gap: (user, video) pairs with real activity but no
--    user_videos row. Informational — ANY value is valid, including 0 (no
--    activity since the 027 backfill, or nothing to reconcile). Nothing
--    wrote user_videos after the 027 backfill, so it is often > 0;
--    02_reconcile_membership.sql closes it after the Phase 6 app is deployed.
--    (Before 040 there are no removal markers, so nothing is excluded here;
--    after 040, fn_phase6_membership_gap() also excludes removed videos.)
select count(*) as membership_gap from (
  select distinct e.user_id, e.youtube_video_id from (
    select user_id, youtube_video_id from learning_sessions where user_id is not null
    union select user_id, youtube_video_id from listening_progress
    union select user_id, youtube_video_id from study_sessions
    union select user_id, youtube_video_id from shadowing_attempts
  ) e
  join users u on u.id = e.user_id
  where not exists (select 1 from user_videos uv where uv.user_id = e.user_id and uv.youtube_video_id = e.youtube_video_id)
) gap;

-- 4. Size of what the new read models aggregate (for expectations only).
select (select count(*) from user_videos) as memberships,
       (select count(*) from learning_sessions) as rounds,
       (select count(*) from study_sessions) as study_sessions,
       (select count(*) from listening_progress) as listening_rows;
