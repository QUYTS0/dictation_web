-- Phase 4 — READ-ONLY preflight. Run in the Supabase SQL editor BEFORE
-- `supabase db push` applies 038. Changes nothing.

-- 1. Phase 3 is activated (the Phase 4 app needs the authoritative writers).
select stage, (stage = 'activated') as ok from phase3_cutover_state;
select completion_writes_paused, legacy_writes_retired, authoritative_writes_active,
       (not completion_writes_paused and legacy_writes_retired and authoritative_writes_active) as ok
from app_write_gate where id = 1;

-- 2. The functions Phase 4 relies on exist with the Phase 3 grants.
select
  has_function_privilege('authenticated', 'public.fn_record_shadowing_attempt(uuid,text,integer,uuid,numeric,uuid,uuid)', 'EXECUTE') as shadow_attempt_granted,
  has_function_privilege('authenticated', 'public.fn_create_or_get_active_round(text,uuid,integer,numeric)', 'EXECUTE') as create_round_granted;
-- expect both true.

-- 3. 038 not applied yet. Before `db push`: begin_fn and round_results_fn
--    are NULL and new_columns = 0. After 038 all three are non-NULL / 4 —
--    but presence and permissions are then checked by 01_postflight.sql, not
--    here. The lookup uses 038's exact signature (uuid, uuid, numeric); an
--    early draft had a two-argument fn_begin_azure_evaluation(uuid, uuid)
--    that the final 038 never creates, so its absence proves nothing.
select to_regprocedure('public.fn_begin_azure_evaluation(uuid,uuid,numeric)') as begin_fn,
       to_regprocedure('public.fn_shadowing_round_results(uuid)') as round_results_fn,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'shadowing_attempts'
           and column_name in ('azure_detail', 'azure_evaluated_at', 'word_match_detail', 'word_match_evaluated_at')) as new_columns;

-- 4. Existing Shadowing data (the Phase 3 app has no Shadowing route, so
--    this is normally 0; 038 changes none of these rows either way).
select count(*) as shadowing_attempts,
       count(*) filter (where azure_eval_status <> 'not_evaluated') as with_azure_state,
       count(*) filter (where word_match_status is not null) as with_word_match
from shadowing_attempts;
