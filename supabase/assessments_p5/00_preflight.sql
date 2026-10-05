-- Learning Reports P5 (AI assessments) — READ-ONLY preflight.
-- Run BEFORE applying 044_ai_assessments.sql. Changes nothing.
-- Every `ok` must be true. The other result sets are information to keep
-- with the rollout record.

-- 1. 043 (P4) is applied and 044 is not.
select to_regclass('public.attempt_explanations') is not null as p4_tables,
       exists (select 1 from pg_trigger where tgname = 'ai_feedback_capture' and tgenabled = 'O') as p4_capture_enabled,
       to_regclass('public.round_assessments') is null as p5_tables_absent,
       not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'attempt_explanations' and column_name = 'note_kind') as note_kind_absent,
       (to_regclass('public.attempt_explanations') is not null
        and exists (select 1 from pg_trigger where tgname = 'ai_feedback_capture' and tgenabled = 'O')
        and to_regclass('public.round_assessments') is null
        and not exists (select 1 from information_schema.columns
                         where table_schema = 'public' and table_name = 'attempt_explanations' and column_name = 'note_kind')) as ok;

-- 2. The P4 data invariants still hold (044 builds on them).
select (select count(*) from ai_feedback f
          join attempt_logs a on a.id = f.attempt_id
          join learning_sessions s on s.id = a.session_id
         where btrim(coalesce(f.explanation, '')) <> '' and s.user_id is not null
           and (select count(*) from attempt_explanations e where e.legacy_feedback_id = f.id) <> 1) as copyable_without_exactly_one_copy,
       (select count(*) - count(distinct legacy_feedback_id) from attempt_explanations where legacy_feedback_id is not null) as duplicate_legacy_ids,
       ((select count(*) from ai_feedback f
           join attempt_logs a on a.id = f.attempt_id
           join learning_sessions s on s.id = a.session_id
          where btrim(coalesce(f.explanation, '')) <> '' and s.user_id is not null
            and (select count(*) from attempt_explanations e where e.legacy_feedback_id = f.id) <> 1) = 0
        and (select count(*) - count(distinct legacy_feedback_id) from attempt_explanations where legacy_feedback_id is not null) = 0) as ok;

-- 3. The legacy writer still has 037's privileges (044 replaces its body only).
select has_function_privilege('service_role', 'public.fn_persist_session_assessment(uuid,uuid,jsonb)', 'EXECUTE') as service_exec,
       has_function_privilege('authenticated', 'public.fn_persist_session_assessment(uuid,uuid,jsonb)', 'EXECUTE') as auth_exec,
       (has_function_privilege('service_role', 'public.fn_persist_session_assessment(uuid,uuid,jsonb)', 'EXECUTE')
        and not has_function_privilege('authenticated', 'public.fn_persist_session_assessment(uuid,uuid,jsonb)', 'EXECUTE')
        and not has_function_privilege('anon', 'public.fn_persist_session_assessment(uuid,uuid,jsonb)', 'EXECUTE')) as ok;

-- 4. Information: legacy assessments that stay visible as the fallback.
select count(*) filter (where ai_assessment is not null) as rounds_with_legacy_assessment,
       count(*) as rounds
  from learning_sessions;

-- 5. Information: P4 operations still running (a P4 app is live while 044 is applied).
select status, count(*) as operations,
       count(*) filter (where status = 'started' and lease_expires_at > clock_timestamp()) as live
  from explanation_operations group by status order by status;
