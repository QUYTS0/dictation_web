-- Phase 3 — READ-ONLY postflight (after step 6).

-- Stage, gate and legacy bridges.
select fn_phase3_status() as status;
-- expect: stage 'activated'; gate completion_writes_paused=false,
-- legacy_writes_retired=true, authoritative_writes_active=true;
-- legacyBridgesPresent all false; policies = [learning_sessions_owner_select].

-- Function permission matrix (effective, incl. PUBLIC and role inheritance). Every row ok = true.
with expected(sig, anon, authed, service) as (values
  ('public.fn_create_or_get_active_round(text,uuid,integer,numeric)', false, true, false),
  ('public.fn_update_resume_position(uuid,text,integer,numeric,uuid)', false, true, false),
  ('public.fn_restart_round(text,uuid)', false, true, false),
  ('public.fn_record_dictation_attempt(uuid,text,integer,uuid,text,text,uuid,uuid,smallint)', false, true, false),
  ('public.fn_record_shadowing_attempt(uuid,text,integer,uuid,numeric,uuid,uuid)', false, true, false),
  ('public.fn_get_or_create_study_session(text,uuid)', false, true, false),
  ('public.fn_flush_study_activity(text,uuid,uuid,text,jsonb,uuid,numeric,text)', false, true, false),
  ('public.fn_practice_write_status()', false, true, false),
  ('public.fn_persist_azure_result(uuid,integer,text,numeric,numeric,numeric,numeric,numeric,text,text)', false, false, true),
  ('public.fn_persist_word_match_result(uuid,integer,text,numeric,numeric)', false, false, true),
  ('public.fn_persist_session_assessment(uuid,uuid,jsonb)', false, false, true),
  ('public.fn_check_write_gate()', false, false, false),
  ('public.fn_check_authoritative_write_gate()', false, false, false),
  ('public.fn_normalize_dictation_text(text,text)', false, false, false),
  ('public.fn_classify_dictation_error(text,text)', false, false, false),
  ('public.fn_round_progress(uuid)', false, false, false),
  ('public.fn_try_complete_round(uuid)', false, false, false),
  ('public.fn_attribute_study_session(uuid,text,uuid,text,uuid)', false, false, false),
  ('public.fn_validate_supplied_study_session(uuid,uuid,text,uuid)', false, false, false),
  ('public.fn_js_has_content(text)', false, false, false),
  ('public.fn_eligible_segment_count(uuid)', false, false, false),
  ('public.fn_phase3_status()', false, false, false),
  ('public.fn_phase3_backfill()', false, false, false),
  ('public.fn_phase3_activate()', false, false, false),
  ('public.fn_phase3_reopen_legacy()', false, false, false)
)
select e.sig,
       has_function_privilege('anon', e.sig, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', e.sig, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', e.sig, 'EXECUTE') as service_exec,
       (has_function_privilege('anon', e.sig, 'EXECUTE') = e.anon
        and has_function_privilege('authenticated', e.sig, 'EXECUTE') = e.authed
        and has_function_privilege('service_role', e.sig, 'EXECUTE') = e.service) as ok
from expected e order by ok, e.sig;

-- No legacy write path remains.
select to_regprocedure('public.fn_legacy_save_progress(uuid,text,uuid,integer,numeric,numeric,integer,text)') as legacy_save,
       to_regprocedure('public.fn_legacy_restart_round(text,uuid)') as legacy_restart,
       to_regprocedure('public.fn_legacy_record_dictation_attempt(uuid,integer,text,text,text,text,boolean,text)') as legacy_record;
-- expect all three NULL.

-- Table privileges: nobody writes learning_sessions/attempt_logs directly.
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('learning_sessions', 'attempt_logs')
  and grantee in ('anon', 'authenticated', 'service_role')
group by 1, 2 order by 1, 2;
-- expect: authenticated SELECT only on both; service_role SELECT only on both; anon none on learning_sessions.

-- New authoritative activity since activation (should grow during the manual check).
select count(*) as verified_attempts_since_activation
from attempt_logs a, phase3_cutover_state s
where a.segment_identity_provenance = 'verified' and a.created_at >= s.activated_at;
select count(*) as current_rounds_since_activation
from learning_sessions l, phase3_cutover_state s
where l.provenance = 'current' and l.started_at >= s.activated_at;

-- Audit trail.
select id, event, at, detail from phase3_cutover_log order by id;
