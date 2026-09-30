-- Phase 5 — READ-ONLY preflight. Run in the Supabase SQL editor BEFORE
-- `supabase db push` applies 039. Changes nothing.

-- 1. Phase 4 is in place (038's exact signature).
select to_regprocedure('public.fn_begin_azure_evaluation(uuid,uuid,numeric)') is not null as phase4_applied;
-- expect true.

-- 2. The Phase 2 functions Phase 5 uses exist with their Phase 2/036 grants.
select
  has_function_privilege('authenticated', 'public.fn_get_or_create_study_session(text,uuid)', 'EXECUTE') as get_session_granted,
  has_function_privilege('authenticated', 'public.fn_flush_study_activity(text,uuid,uuid,text,jsonb,uuid,numeric,text)', 'EXECUTE') as flush_granted,
  has_function_privilege('anon', 'public.fn_flush_study_activity(text,uuid,uuid,text,jsonb,uuid,numeric,text)', 'EXECUTE') as flush_anon;
-- expect true, true, false.

-- 3. 039 not applied yet: its entry point is absent (false before 039,
--    true after — presence and permissions are then checked by
--    01_postflight.sql).
select to_regprocedure('public.fn_sync_study_activity(text,uuid,text,uuid,jsonb,uuid,numeric,text,numeric)') is not null
         as phase5_applied;

-- 4. Existing data these tables hold (normally 0 until Phase 5 ships;
--    listening_progress may contain rows imported from listening_sessions
--    by 026 — legacy_source set, never treated as verified coverage).
select (select count(*) from listening_progress) as listening_progress_rows,
       (select count(*) from listening_progress where legacy_source is not null) as legacy_rows,
       (select count(*) from study_sessions) as study_sessions,
       (select count(*) from activity_flush_log) as flush_log_rows;
