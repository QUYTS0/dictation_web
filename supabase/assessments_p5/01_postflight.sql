-- Learning Reports P5 (AI assessments) — READ-ONLY postflight.
-- Run AFTER 044_ai_assessments.sql, before and after the forward 045 fix, and after the P5 app is
-- deployed, and whenever the invariants must be re-verified. Changes nothing.
-- Every `ok` must be true. After 045 also run 02_identity_postflight.sql.

-- 1. New tables: RLS on, exactly one owner SELECT policy each.
select c.relname, c.relrowsecurity as rls,
       (select string_agg(polname || ':' || polcmd::text, ',' order by polname) from pg_policy where polrelid = c.oid) as policies,
       (c.relrowsecurity
        and (select count(*) from pg_policy where polrelid = c.oid) = 1
        and (select polcmd::text from pg_policy where polrelid = c.oid limit 1) = 'r') as ok
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('round_assessments', 'assessment_generations')
 order by c.relname;
-- expect 2 rows.

-- 2. Table privileges: no application role writes. round_assessments is
--    owner-readable; authenticated reads assessment_generations only by granted
--    column (never token_hash / payload_hash / abandon_reason / user_id).
--    service_role retains SELECT on the entire table, including hashes.
with expected(tbl, role, privs) as (values
  ('round_assessments', 'anon', ''),
  ('round_assessments', 'authenticated', 'SELECT'),
  ('round_assessments', 'service_role', 'SELECT'),
  ('assessment_generations', 'anon', ''),
  ('assessment_generations', 'authenticated', ''),
  ('assessment_generations', 'service_role', 'SELECT')
)
select e.tbl, e.role,
       coalesce((select string_agg(privilege_type, ',' order by privilege_type)
                   from information_schema.role_table_grants g
                  where g.table_schema = 'public' and g.table_name = e.tbl and g.grantee = e.role), '') as table_privileges,
       coalesce((select string_agg(privilege_type, ',' order by privilege_type)
                   from information_schema.role_table_grants g
                  where g.table_schema = 'public' and g.table_name = e.tbl and g.grantee = e.role), '') = e.privs as ok
  from expected e order by e.tbl, e.role;
-- expect 6 rows.

select string_agg(column_name, ',' order by column_name collate "C") as owner_readable_generation_columns,
       string_agg(column_name, ',' order by column_name collate "C")
         = 'created_at,fingerprint,finished_at,generation,lease_expires_at,model,prompt_version,round_id,state' as ok
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'assessment_generations' and grantee = 'authenticated' and privilege_type = 'SELECT';

-- 3. Function permission matrix and hygiene.
with expected(sig, service, definer) as (values
  ('public.fn_assessment_begin(uuid,uuid,text,integer,text)', true, true),
  ('public.fn_assessment_finish(uuid,uuid,integer,uuid,text,integer,text,jsonb,jsonb)', true, true),
  ('public.fn_assessment_abandon(uuid,uuid,integer,uuid,text)', true, true),
  ('public.fn_explanations_finish(uuid,uuid,uuid,uuid,jsonb)', true, true),
  ('public.fn_persist_session_assessment(uuid,uuid,jsonb)', true, true),
  ('public.fn_assessment_legacy_mirror(jsonb)', false, false)
)
select e.sig,
       has_function_privilege('anon', e.sig, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', e.sig, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', e.sig, 'EXECUTE') as service_exec,
       p.prosecdef as security_definer,
       (not has_function_privilege('anon', e.sig, 'EXECUTE')
        and not has_function_privilege('authenticated', e.sig, 'EXECUTE')
        and has_function_privilege('service_role', e.sig, 'EXECUTE') = e.service
        and p.prosecdef = e.definer
        and p.proconfig @> array['search_path=public, pg_temp']) as ok
  from expected e join pg_proc p on p.oid = e.sig::regprocedure
 order by e.sig;
-- expect 6 rows.

-- 4. Note kinds: the additive column and its constraints exist; every duplicate
--    points at an explanation saved by the SAME operation.
select (select column_default from information_schema.columns
         where table_schema = 'public' and table_name = 'attempt_explanations' and column_name = 'note_kind') as note_kind_default,
       (select count(*) from pg_constraint where conrelid = 'public.attempt_explanations'::regclass
         and conname in ('attempt_explanations_note_kind_check', 'attempt_explanations_ref_check', 'attempt_explanations_legacy_kind_check')) as kind_constraints,
       (select count(*) from attempt_explanations d
         where d.note_kind = 'duplicate'
           and not exists (select 1 from attempt_explanations t
                            where t.operation_id = d.operation_id and t.attempt_id = d.ref_attempt_id and t.note_kind = 'explanation')) as orphan_duplicates,
       ((select count(*) from pg_constraint where conrelid = 'public.attempt_explanations'::regclass
          and conname in ('attempt_explanations_note_kind_check', 'attempt_explanations_ref_check', 'attempt_explanations_legacy_kind_check')) = 3
        and (select count(*) from attempt_explanations d
              where d.note_kind = 'duplicate'
                and not exists (select 1 from attempt_explanations t
                                 where t.operation_id = d.operation_id and t.attempt_id = d.ref_attempt_id and t.note_kind = 'explanation')) = 0) as ok;

-- 5. Generation invariants.
select count(*) filter (where ra.accepted_generation is not null and (g.state is distinct from 'accepted' or g.payload_hash is distinct from ra.accepted_payload_hash)) as accepted_mismatch,
       count(*) filter (where ra.user_id is distinct from s.user_id) as owner_mismatch,
       count(*) filter (where ra.accepted_generation is not null and s.ai_assessment is distinct from fn_assessment_legacy_mirror(ra.accepted_payload)) as mirror_mismatch,
       (count(*) filter (where ra.accepted_generation is not null and (g.state is distinct from 'accepted' or g.payload_hash is distinct from ra.accepted_payload_hash)) = 0
        and count(*) filter (where ra.user_id is distinct from s.user_id) = 0
        and count(*) filter (where ra.accepted_generation is not null and s.ai_assessment is distinct from fn_assessment_legacy_mirror(ra.accepted_payload)) = 0) as ok
  from round_assessments ra
  join learning_sessions s on s.id = ra.round_id
  left join assessment_generations g on g.round_id = ra.round_id and g.generation = ra.accepted_generation;
-- mirror_mismatch > 0 after a deliberate app rollback that re-created an
-- unconditional legacy writer would be expected; otherwise it is a failure.

select count(*) filter (where g.generation > ra.latest_started_generation) as generations_above_latest,
       count(*) filter (where g.user_id is distinct from ra.user_id) as generation_owner_mismatch,
       (count(*) filter (where g.generation > ra.latest_started_generation) = 0
        and count(*) filter (where g.user_id is distinct from ra.user_id) = 0) as ok
  from assessment_generations g join round_assessments ra on ra.round_id = g.round_id;

-- 6. P4 capture still enabled (044 must not have disturbed it).
select t.tgenabled, (t.tgenabled = 'O') as ok
  from pg_trigger t where t.tgrelid = 'public.ai_feedback'::regclass and t.tgname = 'ai_feedback_capture';

-- 7. Information: assessments by state.
select count(*) filter (where accepted_generation is not null) as rounds_with_accepted_assessment,
       count(*) filter (where accepted_generation is null) as rounds_with_only_started_generations,
       (select count(*) from assessment_generations where state = 'started' and lease_expires_at > clock_timestamp()) as live_generations,
       (select count(*) from assessment_generations where state = 'abandoned') as abandoned_generations
  from round_assessments;
