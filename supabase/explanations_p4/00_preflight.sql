-- Learning Reports P4 (saved explanations) — READ-ONLY preflight.
-- Run BEFORE applying 043_saved_explanations.sql. Changes nothing.
-- Every `ok` must be true; the other result sets are information to keep
-- with the rollout record (they are compared with the postflight).

-- 1. 043 is not applied yet.
select to_regclass('public.attempt_explanations') as attempt_explanations,
       to_regclass('public.explanation_operations') as explanation_operations,
       (select count(*) from pg_trigger where tgname = 'ai_feedback_capture') as capture_trigger,
       (to_regclass('public.attempt_explanations') is null
        and to_regclass('public.explanation_operations') is null
        and not exists (select 1 from pg_trigger where tgname = 'ai_feedback_capture')) as ok;

-- 2. Prerequisites 043 relies on.
select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'fn_normalize_dictation_text') as normalizer,
       current_setting('server_version_num')::int as server_version_num,
       (exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'fn_normalize_dictation_text')
        and current_setting('server_version_num')::int >= 130000
        and to_regclass('public.ai_feedback') is not null
        and exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'attempt_logs' and column_name = 'match_mode')) as ok;

-- 3. Legacy ai_feedback inventory (information): what the backfill will copy
--    and what it cannot copy, by reason. Rows that cannot be copied are never
--    discarded — they stay in ai_feedback and are listed again by the postflight.
select count(*) as legacy_rows,
       count(*) filter (where f.attempt_id is not null and btrim(coalesce(f.explanation, '')) <> '' and s.user_id is not null) as copyable,
       count(*) filter (where f.attempt_id is null) as not_copyable_no_attempt,
       count(*) filter (where f.attempt_id is not null and btrim(coalesce(f.explanation, '')) = '') as not_copyable_blank_explanation,
       count(*) filter (where f.attempt_id is not null and btrim(coalesce(f.explanation, '')) <> '' and s.user_id is null) as not_copyable_round_without_owner,
       count(distinct f.attempt_id) as distinct_attempts,
       min(f.created_at) as oldest, max(f.created_at) as newest
  from ai_feedback f
  left join attempt_logs a on a.id = f.attempt_id
  left join learning_sessions s on s.id = a.session_id;

-- 4. Attempts with more than one legacy row (information; all are copied,
--    the newest by (created_at, id) is the effective one).
select count(*) as attempts_with_duplicates, coalesce(max(n), 0) as max_rows_per_attempt
  from (select attempt_id, count(*) n from ai_feedback where attempt_id is not null group by attempt_id having count(*) > 1) d;
