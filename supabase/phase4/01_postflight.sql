-- Phase 4 — READ-ONLY postflight. Run AFTER 038 is applied (and again after
-- the Phase 4 app is deployed). Changes nothing. Every `ok` must be true.

-- 1. New columns (nullable, no default).
select column_name, data_type, is_nullable, column_default,
       (is_nullable = 'YES' and column_default is null) as ok
from information_schema.columns
where table_schema = 'public' and table_name = 'shadowing_attempts'
  and column_name in ('azure_detail', 'azure_evaluated_at', 'word_match_detail', 'word_match_evaluated_at')
order by column_name;
-- expect 4 rows.

-- 2. Function permission matrix for 038 (effective, incl. PUBLIC).
with expected(sig, anon, authed, service) as (values
  ('public.fn_begin_azure_evaluation(uuid,uuid)', false, false, true),
  ('public.fn_finish_azure_evaluation(uuid,uuid,integer,text,numeric,numeric,numeric,numeric,numeric,jsonb,text,text)', false, false, true),
  ('public.fn_expire_azure_evaluation(uuid,uuid,integer)', false, false, true),
  ('public.fn_record_word_match(uuid,uuid,text,numeric,numeric,jsonb)', false, false, true),
  ('public.fn_get_shadowing_attempt(uuid)', false, true, false),
  ('public.fn_shadowing_round_results(uuid)', false, true, false),
  ('public.fn_shadowing_attempt_dto(shadowing_attempts,boolean)', false, true, false),
  ('public.fn_shadowing_eval_timeout_sec()', false, true, false),
  -- unchanged Phase 3 rows Phase 4 depends on
  ('public.fn_record_shadowing_attempt(uuid,text,integer,uuid,numeric,uuid,uuid)', false, true, false),
  ('public.fn_create_or_get_active_round(text,uuid,integer,numeric)', false, true, false),
  ('public.fn_persist_azure_result(uuid,integer,text,numeric,numeric,numeric,numeric,numeric,text,text)', false, false, true),
  ('public.fn_persist_word_match_result(uuid,integer,text,numeric,numeric)', false, false, true)
)
select e.sig,
       has_function_privilege('anon', e.sig, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', e.sig, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', e.sig, 'EXECUTE') as service_exec,
       (has_function_privilege('anon', e.sig, 'EXECUTE') = e.anon
        and has_function_privilege('authenticated', e.sig, 'EXECUTE') = e.authed
        and has_function_privilege('service_role', e.sig, 'EXECUTE') = e.service) as ok
from expected e order by ok, e.sig;

-- 3. The writer functions are SECURITY DEFINER with a pinned search_path;
--    the reads are SECURITY INVOKER (the caller's own RLS applies).
select p.proname, p.prosecdef as security_definer, p.proconfig,
       (p.proconfig @> array['search_path=public, pg_temp']
        and p.prosecdef = (p.proname in ('fn_begin_azure_evaluation', 'fn_finish_azure_evaluation',
                                         'fn_expire_azure_evaluation', 'fn_record_word_match'))) as ok
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_begin_azure_evaluation', 'fn_finish_azure_evaluation', 'fn_expire_azure_evaluation',
                    'fn_record_word_match', 'fn_get_shadowing_attempt', 'fn_shadowing_round_results',
                    'fn_shadowing_attempt_dto', 'fn_shadowing_eval_timeout_sec')
order by p.proname;

-- 4. Phase 3 table privileges are untouched: app roles only SELECT
--    learning_sessions / attempt_logs; users only SELECT shadowing_attempts.
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges,
       (string_agg(privilege_type, ',' order by privilege_type) = 'SELECT'
        or (table_name = 'shadowing_attempts' and grantee = 'service_role')) as ok
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('learning_sessions', 'attempt_logs', 'shadowing_attempts')
  and grantee in ('anon', 'authenticated', 'service_role')
group by 1, 2 order by 1, 2;

-- 5. Health of the evaluation lifecycle (run after real use). Evaluations
--    stuck pending beyond the timeout are reported as expired by the app
--    and should stay near zero.
select count(*) as shadowing_attempts,
       count(*) filter (where is_practice_valid) as practice_valid,
       count(*) filter (where azure_eval_status = 'completed') as azure_completed,
       count(*) filter (where azure_eval_status = 'failed') as azure_failed,
       count(*) filter (where azure_eval_status = 'pending'
                          and eval_requested_at < now() - make_interval(secs => fn_shadowing_eval_timeout_sec())) as azure_overdue_pending,
       count(*) filter (where word_match_status = 'completed') as word_match_completed
from shadowing_attempts;
