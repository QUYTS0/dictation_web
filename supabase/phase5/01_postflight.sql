-- Phase 5 — READ-ONLY postflight. Run AFTER 039 is applied (and again after
-- the Phase 5 app is deployed and used). Changes nothing. Every `ok` must be true.

-- 1. 039's three functions are in place, SECURITY DEFINER with a pinned
--    search_path, and the batch-id index exists.
select p.proname, p.prosecdef as security_definer, p.proconfig,
       (p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']) as ok
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('fn_apply_study_flush', 'fn_flush_study_activity', 'fn_sync_study_activity')
order by p.proname;
-- expect 3 rows.
select to_regclass('public.activity_flush_log_batch_idx') is not null as batch_index_present;
-- expect true.

-- 2. Function permission matrix (effective, incl. PUBLIC).
with expected(sig, anon, authed, service) as (values
  ('public.fn_sync_study_activity(text,uuid,text,uuid,jsonb,uuid,numeric,text,numeric)', false, true, false),
  ('public.fn_flush_study_activity(text,uuid,uuid,text,jsonb,uuid,numeric,text)', false, true, false),
  ('public.fn_get_or_create_study_session(text,uuid)', false, true, false),
  -- internal: no application role may call it
  ('public.fn_apply_study_flush(uuid,text,uuid,uuid,text,jsonb,uuid,numeric,text,boolean)', false, false, false)
)
select e.sig,
       has_function_privilege('anon', e.sig, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', e.sig, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', e.sig, 'EXECUTE') as service_exec,
       (has_function_privilege('anon', e.sig, 'EXECUTE') = e.anon
        and has_function_privilege('authenticated', e.sig, 'EXECUTE') = e.authed
        and has_function_privilege('service_role', e.sig, 'EXECUTE') = e.service) as ok
from expected e order by e.sig;
-- expect 4 rows.

-- 3. Table privileges unchanged: app users only SELECT their own rows
--    (owner RLS); every write goes through the SECURITY DEFINER functions.
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges,
       (string_agg(privilege_type, ',' order by privilege_type) = 'SELECT') as ok
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('listening_progress', 'study_sessions', 'activity_flush_log')
  and grantee in ('anon', 'authenticated')
group by 1, 2 order by 1, 2;

-- 4. Health after real use: synced revisions, listened-through videos, and
--    sessions that recorded Listening. Coverage never exceeds 1.
select count(*) filter (where transcript_id is not null) as revision_rows,
       count(*) filter (where listened_through) as listened_through,
       count(*) filter (where coverage_ratio > 1 or coverage_ratio < 0) as invalid_ratios,
       (select count(*) from study_sessions where modes_used ? 'listening') as listening_sessions,
       (select count(*) from study_sessions where jsonb_array_length(activity_intervals) > 0) as sessions_with_activity
from listening_progress;
