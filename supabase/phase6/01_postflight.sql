-- Phase 6 — READ-ONLY postflight. Run AFTER 040 is applied (and again after
-- the Phase 6 app is deployed and 02_reconcile_membership.sql has run).
-- Changes nothing. Every `ok` must be true.

-- 1. Functions: SECURITY DEFINER where required, pinned search_path everywhere.
--    (The five pure helpers run inside definer functions and need no definer.)
select p.proname, p.prosecdef as security_definer, p.proconfig,
       (p.proconfig @> array['search_path=public, pg_temp']
        and (p.prosecdef or p.proname in ('fn_word_count', 'fn_valid_video_id', 'fn_lock_library_entry',
                                          'fn_valid_time_zone', 'fn_local_activity_dates'))) as ok
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (
  'fn_library_add_video', 'fn_library_remove_video', 'fn_set_video_last_mode', 'fn_video_last_mode', 'fn_video_library',
  'fn_dashboard_summary', 'fn_activity_days', 'fn_history_sessions', 'fn_round_report', 'fn_my_round_progress',
  'fn_dictation_accuracy_summary', 'fn_shadowing_summary', 'fn_activity_union', 'fn_word_count', 'fn_valid_video_id',
  'fn_lock_library_entry', 'fn_valid_time_zone', 'fn_local_activity_dates', 'fn_apply_study_flush',
  'fn_phase6_reconcile_membership', 'fn_phase6_membership_gap')
order by p.proname;
-- expect 21 rows (fn_apply_study_flush is 039's function, replaced by 040).

-- 2. Function permission matrix (effective, incl. PUBLIC).
with expected(sig, anon, authed, service) as (values
  ('public.fn_library_add_video(text,boolean)', false, true, false),
  ('public.fn_library_remove_video(text)', false, true, false),
  ('public.fn_set_video_last_mode(text,text)', false, true, false),
  ('public.fn_video_last_mode(text)', false, true, false),
  ('public.fn_video_library(integer,integer,text)', false, true, false),
  ('public.fn_dashboard_summary()', false, true, false),
  ('public.fn_activity_days()', false, true, false),
  ('public.fn_history_sessions(integer,timestamptz,uuid,text)', false, true, false),
  ('public.fn_round_report(uuid)', false, true, false),
  ('public.fn_my_round_progress(uuid)', false, true, false),
  -- internal: no application role may call them (they take a user id / are operator-only)
  ('public.fn_dictation_accuracy_summary(uuid,uuid)', false, false, false),
  ('public.fn_shadowing_summary(uuid,uuid)', false, false, false),
  ('public.fn_activity_union(uuid,uuid,uuid)', false, false, false),
  ('public.fn_lock_library_entry(uuid,text)', false, false, false),
  ('public.fn_valid_time_zone(text)', false, false, false),
  ('public.fn_local_activity_dates(jsonb,text)', false, false, false),
  ('public.fn_apply_study_flush(uuid,text,uuid,uuid,text,jsonb,uuid,numeric,text,boolean)', false, false, false),
  ('public.fn_phase6_reconcile_membership()', false, false, false),
  ('public.fn_phase6_membership_gap()', false, false, false)
)
select e.sig,
       has_function_privilege('anon', e.sig, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', e.sig, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', e.sig, 'EXECUTE') as service_exec,
       (has_function_privilege('anon', e.sig, 'EXECUTE') = e.anon
        and has_function_privilege('authenticated', e.sig, 'EXECUTE') = e.authed
        and has_function_privilege('service_role', e.sig, 'EXECUTE') = e.service) as ok
from expected e order by e.sig;
-- expect 19 rows.

-- 3. Tombstones: app users may only SELECT their own rows (owner RLS);
--    writes go through fn_library_remove_video / fn_library_add_video.
select grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges,
       (grantee = 'authenticated' and string_agg(privilege_type, ',' order by privilege_type) = 'SELECT') as ok
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'user_video_removals' and grantee in ('anon', 'authenticated', 'service_role')
group by grantee order by grantee;
-- expect exactly one row: authenticated / SELECT.
select relrowsecurity as rls_enabled from pg_class where oid = 'public.user_video_removals'::regclass;
-- expect true.

-- 4. Existing tables untouched by 040: learning_sessions / attempt_logs keep
--    their Phase 3 write model (no INSERT/UPDATE/DELETE for app roles).
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges,
       (string_agg(privilege_type, ',' order by privilege_type) = 'SELECT') as ok
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('learning_sessions', 'attempt_logs', 'study_sessions', 'listening_progress')
  and grantee in ('anon', 'authenticated')
group by 1, 2 order by 1, 2;

-- 5. Membership gap: eligible (user, video) pairs with activity but no
--    membership, EXCLUDING videos the user removed (never counted, never
--    re-added). 0 once 02_reconcile_membership.sql has run; 0 before it is
--    also valid (nothing to reconcile). Not an `ok` check.
select fn_phase6_membership_gap() as membership_gap,
       (select count(*) from user_video_removals) as removals;

-- 6. Health after real use.
select (select count(*) from user_videos) as memberships,
       (select count(*) from user_videos where last_mode is not null) as with_last_mode,
       (select count(*) from learning_sessions where status = 'completed' and provenance = 'current') as verified_completed_rounds,
       (select count(*) from learning_sessions where status = 'completed' and provenance = 'legacy_unverified') as legacy_completed_rounds;

-- 7. New columns: the removed video's last mode; the activity batch's
--    timezone, local dates and day basis.
select table_name, column_name, data_type, true as ok
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'user_video_removals' and column_name = 'last_mode')
    or (table_name = 'activity_flush_log' and column_name in ('client_timezone', 'activity_dates', 'day_basis')))
order by table_name, column_name;
-- expect 4 rows.

-- 8. Day attribution after real use: activity batches recorded since 040
--    carry local dates (day_basis = local) or, without a valid timezone, UTC
--    dates (utc_fallback). Batches from before 040 stay unattributed (NULL)
--    and their days use the documented UTC fallback.
select day_basis, count(*) as batches, count(distinct client_timezone) as time_zones
from activity_flush_log where kind = 'activity'
group by day_basis order by day_basis nulls first;
