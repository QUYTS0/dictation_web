-- 045 — Authenticate accepted retries against their own generation identity.
-- 044 is already applied; do not edit or replay it. No data or ACL changes.
begin;

comment on table assessment_generations is
  'Learning Reports P5: one row per started assessment generation (ordering, lease, token hash). authenticated can SELECT only its granted columns on owned rows (RLS), excluding token_hash and payload_hash. service_role can SELECT the entire table, including hashes. Writes use the service-role-only SECURITY DEFINER RPCs.';

-- Lock order remains learning_sessions -> round_assessments -> assessment_generations.
-- Ownership and token checks precede identity validation. Identity belongs to
-- v_g, including historical accepted generations, never the latest result.
-- Accepted retries return before any writes or current-version checks, so an
-- older accepted generation cannot replace a newer assessment or its mirror.
-- CREATE OR REPLACE preserves the existing owner and function privileges.
create or replace function fn_assessment_finish(
  p_user_id uuid,
  p_round_id uuid,
  p_generation integer,
  p_token uuid,
  p_fingerprint text,
  p_prompt_version integer,
  p_model text,
  p_payload jsonb,
  p_meta jsonb
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_ra round_assessments%rowtype;
  v_g assessment_generations%rowtype;
  v_hash text;
begin
  if p_user_id is null or p_round_id is null or p_generation is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select user_id into v_owner from learning_sessions where id = p_round_id for no key update;
  if not found or v_owner is distinct from p_user_id then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into v_ra from round_assessments where round_id = p_round_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into v_g from assessment_generations
   where round_id = p_round_id and generation = p_generation and user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_token is null or encode(sha256(convert_to(p_token::text, 'UTF8')), 'hex') <> v_g.token_hash then
    return jsonb_build_object('status', 'invalid_token');
  end if;
  if v_g.state = 'abandoned' then
    return jsonb_build_object('status', 'invalid_state', 'generationState', 'abandoned');
  end if;
  if p_fingerprint is distinct from v_g.fingerprint or p_prompt_version is distinct from v_g.prompt_version
     or p_model is distinct from v_g.model then
    return jsonb_build_object('status', 'invalid_identity');
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or jsonb_typeof(p_payload -> 'overview') is distinct from 'string'
     or btrim(p_payload ->> 'overview') = ''
     or pg_column_size(p_payload) > 65536
     or (p_meta is not null and (jsonb_typeof(p_meta) <> 'object' or pg_column_size(p_meta) > 16384)) then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  v_hash := encode(sha256(convert_to(jsonb_build_object('payload', p_payload, 'meta', coalesce(p_meta, '{}'::jsonb))::text, 'UTF8')), 'hex');

  if v_g.state = 'accepted' then
    if v_g.payload_hash = v_hash then
      return jsonb_build_object('status', 'already_accepted', 'generation', v_g.generation);
    end if;
    return jsonb_build_object('status', 'conflict', 'generation', v_g.generation);
  end if;

  if p_generation < v_ra.latest_started_generation then
    return jsonb_build_object('status', 'superseded', 'latestGeneration', v_ra.latest_started_generation);
  end if;
  if v_ra.accepted_prompt_version is not null and p_prompt_version < v_ra.accepted_prompt_version then
    return jsonb_build_object('status', 'outdated_app');
  end if;

  update assessment_generations
     set state = 'accepted', payload_hash = v_hash, lease_expires_at = null, finished_at = clock_timestamp()
   where round_id = p_round_id and generation = p_generation;
  update round_assessments
     set accepted_generation = p_generation, accepted_fingerprint = p_fingerprint,
         accepted_prompt_version = p_prompt_version, accepted_model = p_model,
         accepted_payload_hash = v_hash, accepted_payload = p_payload,
         accepted_meta = coalesce(p_meta, '{}'::jsonb), accepted_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where round_id = p_round_id;
  -- Legacy mirror for old readers (same transaction, same lock).
  update learning_sessions
     set ai_assessment = fn_assessment_legacy_mirror(p_payload), ai_assessment_generated_at = now()
   where id = p_round_id;

  return jsonb_build_object('status', 'accepted', 'generation', p_generation);
end;
$$;

commit;
