-- READ ONLY: run after 045_assessment_finish_identity.sql, as project owner.
-- Also run 01_postflight.sql for the full grant/RLS/data/legacy-mirror checks.
-- Every ok must be true. This verifies installed source structure; actual
-- behavior is covered by the disposable 044 -> 045 upgrade regression suite.
with definition as (
  select lower(pg_get_functiondef(
    'public.fn_assessment_finish(uuid,uuid,integer,uuid,text,integer,text,jsonb,jsonb)'::regprocedure
  )) as body
), positions as (
  select position('if p_token is null' in body) as token_check,
         position('if p_fingerprint is distinct from v_g.fingerprint' in body) as identity_check,
         position('p_prompt_version is distinct from v_g.prompt_version' in body) as prompt_check,
         position('p_model is distinct from v_g.model' in body) as model_check,
         position('''invalid_identity''' in body) as identity_rejection,
         position('if v_g.state = ''accepted''' in body) as accepted_retry
    from definition
)
select *, (token_check > 0 and identity_check > token_check
           and prompt_check > identity_check and model_check > prompt_check
           and identity_rejection > model_check and accepted_retry > identity_rejection) as ok
  from positions;

select obj_description('public.assessment_generations'::regclass, 'pg_class') as table_comment,
       coalesce(obj_description('public.assessment_generations'::regclass, 'pg_class')
         like '%authenticated can SELECT only its granted columns%service_role can SELECT the entire table, including hashes.%', false) as ok;

select (not has_column_privilege('authenticated', 'public.assessment_generations', 'token_hash', 'SELECT')
        and not has_column_privilege('authenticated', 'public.assessment_generations', 'payload_hash', 'SELECT')
        and has_table_privilege('service_role', 'public.assessment_generations', 'SELECT')
        and has_column_privilege('service_role', 'public.assessment_generations', 'token_hash', 'SELECT')
        and has_column_privilege('service_role', 'public.assessment_generations', 'payload_hash', 'SELECT')) as ok;
