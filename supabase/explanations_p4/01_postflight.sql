-- Learning Reports P4 (saved explanations) — READ-ONLY postflight.
-- Run AFTER 043_saved_explanations.sql is applied, again after the P4 app is
-- deployed, and whenever capture must be re-verified. Changes nothing.
-- Every `ok` must be true.
--
-- Note: do NOT compare total row counts of ai_feedback and its copies.
-- attempt_explanations keeps copies after the legacy row is deleted (that is
-- the point), so it may legitimately hold MORE legacy copies than
-- ai_feedback has rows. The checks below are per source row instead.

-- 1. Tables exist with RLS enabled and exactly the owner SELECT policy.
select c.relname, c.relrowsecurity as rls,
       (select string_agg(polname, ',' order by polname) from pg_policy where polrelid = c.oid) as policies,
       (c.relrowsecurity and (
          (c.relname = 'attempt_explanations'
             and (select string_agg(polname || ':' || polcmd::text, ',' order by polname) from pg_policy where polrelid = c.oid)
                 = 'attempt_explanations_owner_select:r')
          or (c.relname = 'explanation_operations'
             and not exists (select 1 from pg_policy where polrelid = c.oid)))) as ok
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('attempt_explanations', 'explanation_operations')
 order by c.relname;
-- expect 2 rows.

-- 2. Table privileges: no application role can write; authenticated reads
--    only attempt_explanations (through RLS); service_role reads both.
with expected(tbl, role, privs) as (values
  ('attempt_explanations', 'anon', ''),
  ('attempt_explanations', 'authenticated', 'SELECT'),
  ('attempt_explanations', 'service_role', 'SELECT'),
  ('explanation_operations', 'anon', ''),
  ('explanation_operations', 'authenticated', ''),
  ('explanation_operations', 'service_role', 'SELECT')
)
select e.tbl, e.role,
       coalesce((select string_agg(privilege_type, ',' order by privilege_type)
                   from information_schema.role_table_grants g
                  where g.table_schema = 'public' and g.table_name = e.tbl and g.grantee = e.role), '') as privileges,
       coalesce((select string_agg(privilege_type, ',' order by privilege_type)
                   from information_schema.role_table_grants g
                  where g.table_schema = 'public' and g.table_name = e.tbl and g.grantee = e.role), '') = e.privs
       and not has_table_privilege('public', 'public.' || e.tbl, 'INSERT') as ok
  from expected e order by e.tbl, e.role;
-- expect 6 rows.

-- 3. Function permission matrix (effective, including PUBLIC) and hygiene:
--    writer RPCs and capture helpers are SECURITY DEFINER; every function
--    pins search_path.
with expected(sig, service, definer) as (values
  ('public.fn_explanations_begin(uuid,uuid,uuid[],text,text,integer,text)', true, true),
  ('public.fn_explanations_finish(uuid,uuid,uuid,uuid,jsonb)', true, true),
  ('public.fn_explanations_abandon(uuid,uuid,uuid,uuid,text)', true, true),
  ('public.fn_capture_legacy_feedback_row(uuid,uuid,text,text,text,timestamptz)', false, true),
  ('public.fn_ai_feedback_capture()', false, true),
  ('public.fn_explanation_pattern_key(text,text,text)', false, false),
  ('public.fn_copy_legacy_ai_feedback()', false, false)  -- operator-only (owner)
)
select e.sig,
       has_function_privilege('anon', e.sig, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', e.sig, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', e.sig, 'EXECUTE') as service_exec,
       p.prosecdef as security_definer, p.proconfig,
       (not has_function_privilege('anon', e.sig, 'EXECUTE')
        and not has_function_privilege('authenticated', e.sig, 'EXECUTE')
        and has_function_privilege('service_role', e.sig, 'EXECUTE') = e.service
        and p.prosecdef = e.definer
        and p.proconfig @> array['search_path=public, pg_temp']) as ok
  from expected e join pg_proc p on p.oid = e.sig::regprocedure
 order by e.sig;
-- expect 7 rows.

-- 4. Capture trigger installed and enabled on ai_feedback.
select t.tgname, t.tgenabled, p.proname,
       (t.tgenabled = 'O' and p.proname = 'fn_ai_feedback_capture') as ok
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'public.ai_feedback'::regclass and t.tgname = 'ai_feedback_capture';
-- expect 1 row.

-- 5. Every CURRENTLY EXISTING copyable legacy row has exactly one copy.
select count(*) filter (where copies = 0) as copyable_without_copy,
       count(*) filter (where copies > 1) as copyable_with_several_copies,
       count(*) as copyable_rows,
       (count(*) filter (where copies <> 1) = 0) as ok
  from (
    select f.id, (select count(*) from attempt_explanations e where e.legacy_feedback_id = f.id) as copies
      from ai_feedback f
      join attempt_logs a on a.id = f.attempt_id
      join learning_sessions s on s.id = a.session_id
     where btrim(coalesce(f.explanation, '')) <> '' and s.user_id is not null
  ) x;

-- 6. Copies match their (still existing) source: content, original
--    timestamp, attempt, and the attempt → round → owner chain.
select count(*) as mismatched_copies, (count(*) = 0) as ok
  from attempt_explanations e
  join ai_feedback f on f.id = e.legacy_feedback_id
  join attempt_logs a on a.id = f.attempt_id
  join learning_sessions s on s.id = a.session_id
 where e.attempt_id is distinct from f.attempt_id
    or e.explanation is distinct from f.explanation
    or e.corrected_text is distinct from f.corrected_text
    or e.example_text is distinct from f.example_text
    or e.created_at is distinct from f.created_at
    or e.round_id is distinct from a.session_id
    or e.user_id is distinct from s.user_id;

-- 7. Every saved note (legacy copy or new) belongs to its attempt's round
--    and that round's owner; new notes carry their operation's seq/version.
select count(*) as inconsistent_notes, (count(*) = 0) as ok
  from attempt_explanations e
  join attempt_logs a on a.id = e.attempt_id
  join learning_sessions s on s.id = a.session_id
  left join explanation_operations o on o.id = e.operation_id
 where e.round_id <> a.session_id
    or e.user_id is distinct from s.user_id
    or (e.operation_id is not null and (o.id is null or o.seq <> e.seq or o.round_id <> e.round_id
        or o.prompt_version <> e.prompt_version or o.model <> e.model or o.status <> 'accepted'
        or not (e.attempt_id = any(o.target_attempt_ids))));

-- 8. No duplicate legacy source ids (also enforced by a unique constraint).
select count(*) - count(distinct legacy_feedback_id) as duplicate_legacy_ids,
       (count(*) = count(distinct legacy_feedback_id)) as ok
  from attempt_explanations where legacy_feedback_id is not null;

-- 9. Information: copies whose legacy source row no longer exists (captured
--    before a legacy DELETE — expected to be ≥ 0, never a failure).
select count(*) as preserved_after_legacy_delete
  from attempt_explanations e
 where e.source = 'legacy_ai_feedback'
   and not exists (select 1 from ai_feedback f where f.id = e.legacy_feedback_id);

-- 10. Information: legacy rows that cannot be copied, by reason. They are
--     kept in ai_feedback (not discarded) and never get an invented owner.
select f.id as ai_feedback_id, f.attempt_id, f.created_at,
       case when f.attempt_id is null then 'no_attempt'
            when btrim(coalesce(f.explanation, '')) = '' then 'blank_explanation'
            when s.user_id is null then 'round_without_owner'
       end as reason
  from ai_feedback f
  left join attempt_logs a on a.id = f.attempt_id
  left join learning_sessions s on s.id = a.session_id
 where f.attempt_id is null or btrim(coalesce(f.explanation, '')) = '' or s.user_id is null
 order by f.created_at, f.id;

-- 11. Information: operations by status, and live ones.
select status, count(*) as operations,
       count(*) filter (where status = 'started' and lease_expires_at > clock_timestamp()) as live
  from explanation_operations group by status order by status;
