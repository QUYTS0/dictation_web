-- =====================================================
-- 044 — AI assessments, note kinds, guarded legacy writer (Learning Reports P5)
--
-- Builds on 043 (unchanged). Contents:
--   1. attempt_explanations.note_kind / ref_attempt_id (additive): a model
--      answer may be stored honestly as a 'minor' note, or as a 'duplicate'
--      that points at an explanation saved IN THE SAME operation. Nothing
--      empty is ever stored, and a duplicate without a real saved target is
--      refused.
--   2. fn_explanations_finish replaced (same signature) to accept those
--      kinds. The canonical payload of an ordinary explanation item is
--      byte-identical to 043's, so a P4-era operation's hash is unchanged.
--   3. round_assessments (one row per round: the accepted assessment) and
--      assessment_generations (one row per started generation, with its
--      token hash kept for its whole life, so every finish/abandon is
--      authenticated — including after acceptance, lease expiry or
--      supersession).
--   4. fn_assessment_begin / _finish / _abandon (service role only).
--   5. fn_persist_session_assessment replaced: same contract, but it takes
--      the per-round lock and refuses once a new-format assessment has been
--      ACCEPTED for the round (a started/abandoned/expired generation does
--      not block it).
--
-- Per-round lock protocol (shared with 043): every AI writer first runs
--   select … from learning_sessions where id = round for no key update
-- then takes, in this order only: round_assessments → assessment_generations
-- → explanation_operations. Provider calls never run inside a transaction.
--
-- See .claude/learning-reports-review-plan.md §8–§10 and
-- supabase/P5_ASSESSMENT_RUNBOOK.md.
-- =====================================================

begin;

-- -------------------------------------------------------------------------
-- 1. Note kinds (additive; existing rows are explanations)
-- -------------------------------------------------------------------------
alter table attempt_explanations
  add column note_kind text not null default 'explanation',
  add column ref_attempt_id uuid null references attempt_logs(id) on delete cascade;
alter table attempt_explanations
  add constraint attempt_explanations_note_kind_check check (note_kind in ('explanation', 'minor', 'duplicate')),
  add constraint attempt_explanations_ref_check check ((note_kind = 'duplicate') = (ref_attempt_id is not null)),
  add constraint attempt_explanations_legacy_kind_check check (source <> 'legacy_ai_feedback' or note_kind = 'explanation');

comment on column attempt_explanations.note_kind is
  'P5: explanation (full note) | minor (non-empty short note: not a language issue) | duplicate (non-empty note pointing at ref_attempt_id, an explanation saved by the same operation).';

-- -------------------------------------------------------------------------
-- 2. fn_explanations_finish with note kinds (same signature and checks as
--    043; only the item vocabulary is wider)
-- -------------------------------------------------------------------------
create or replace function fn_explanations_finish(
  p_user_id uuid,
  p_round_id uuid,
  p_operation_id uuid,
  p_token uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_op explanation_operations%rowtype;
  v_n integer;
  v_bad boolean;
  v_items jsonb;
  v_hash text;
begin
  if p_user_id is null or p_round_id is null or p_operation_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select user_id into v_owner from learning_sessions where id = p_round_id for no key update;
  if not found or v_owner is distinct from p_user_id then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into v_op from explanation_operations
   where id = p_operation_id and round_id = p_round_id and user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_token is null or encode(sha256(convert_to(p_token::text, 'UTF8')), 'hex') <> v_op.token_hash then
    return jsonb_build_object('status', 'invalid_token');
  end if;
  if v_op.status = 'abandoned' then
    return jsonb_build_object('status', 'invalid_state', 'operationStatus', 'abandoned');
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('status', 'invalid_payload', 'reason', 'not_an_array');
  end if;
  v_n := jsonb_array_length(p_items);
  if v_n = 0 then
    return jsonb_build_object('status', 'invalid_payload', 'reason', 'empty');
  end if;
  if v_n > cardinality(v_op.target_attempt_ids) or pg_column_size(p_items) > 262144 then
    return jsonb_build_object('status', 'invalid_payload', 'reason', 'too_large');
  end if;
  select coalesce(bool_or(not ok), false) into v_bad
    from (
      select case when jsonb_typeof(el) <> 'object' then false else
               coalesce((select bool_and(k in ('attemptId', 'explanation', 'correctedText', 'example', 'tip', 'kind', 'refAttemptId'))
                           from jsonb_object_keys(el) k), true)
               and coalesce(jsonb_typeof(el -> 'attemptId') = 'string', false)
               and coalesce((el ->> 'attemptId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
               and coalesce(jsonb_typeof(el -> 'explanation') = 'string', false)
               and btrim(coalesce(el ->> 'explanation', '')) <> ''
               and length(el ->> 'explanation') <= 4000
               and coalesce(jsonb_typeof(el -> 'correctedText'), 'null') in ('string', 'null')
               and length(coalesce(el ->> 'correctedText', '')) <= 2000
               and coalesce(jsonb_typeof(el -> 'example'), 'null') in ('string', 'null')
               and length(coalesce(el ->> 'example', '')) <= 2000
               and coalesce(jsonb_typeof(el -> 'tip'), 'null') in ('string', 'null')
               and length(coalesce(el ->> 'tip', '')) <= 1000
               and coalesce(el ->> 'kind', 'explanation') in ('explanation', 'minor', 'duplicate')
               and coalesce(jsonb_typeof(el -> 'kind'), 'string') in ('string', 'null')
               and (case coalesce(el ->> 'kind', 'explanation')
                      when 'duplicate' then
                        coalesce(jsonb_typeof(el -> 'refAttemptId') = 'string', false)
                        and coalesce((el ->> 'refAttemptId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
                        and length(el ->> 'explanation') <= 500
                      when 'minor' then
                        coalesce(jsonb_typeof(el -> 'refAttemptId'), 'null') = 'null'
                        and length(el ->> 'explanation') <= 500
                      else coalesce(jsonb_typeof(el -> 'refAttemptId'), 'null') = 'null'
                    end)
             end as ok
        from jsonb_array_elements(p_items) el
    ) v;
  if v_bad then
    return jsonb_build_object('status', 'invalid_payload', 'reason', 'malformed_item');
  end if;
  if (select count(distinct lower(el ->> 'attemptId')) from jsonb_array_elements(p_items) el) <> v_n then
    return jsonb_build_object('status', 'invalid_payload', 'reason', 'duplicate_attempt');
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) el
              where not ((el ->> 'attemptId')::uuid = any(v_op.target_attempt_ids))) then
    return jsonb_build_object('status', 'invalid_payload', 'reason', 'not_a_target');
  end if;
  -- A duplicate must point at a DIFFERENT item of this same payload that is a
  -- full explanation: it is saved atomically with it, so "covered" is real.
  if exists (
    select 1 from jsonb_array_elements(p_items) d
     where d ->> 'kind' = 'duplicate'
       and (lower(d ->> 'refAttemptId') = lower(d ->> 'attemptId')
            or not exists (select 1 from jsonb_array_elements(p_items) t
                            where lower(t ->> 'attemptId') = lower(d ->> 'refAttemptId')
                              and coalesce(t ->> 'kind', 'explanation') = 'explanation'))
  ) then
    return jsonb_build_object('status', 'invalid_payload', 'reason', 'bad_duplicate_ref');
  end if;

  -- Canonical form. An ordinary explanation item has exactly 043's five
  -- keys (so a P4-era payload hashes identically); other kinds add theirs.
  select jsonb_agg(
           case when coalesce(el ->> 'kind', 'explanation') = 'explanation' then
             jsonb_build_object(
               'attemptId', lower(el ->> 'attemptId'),
               'explanation', el ->> 'explanation',
               'correctedText', el ->> 'correctedText',
               'example', el ->> 'example',
               'tip', el ->> 'tip')
           else
             jsonb_build_object(
               'attemptId', lower(el ->> 'attemptId'),
               'explanation', el ->> 'explanation',
               'correctedText', el ->> 'correctedText',
               'example', el ->> 'example',
               'tip', el ->> 'tip',
               'kind', el ->> 'kind',
               'refAttemptId', lower(el ->> 'refAttemptId'))
           end
           order by lower(el ->> 'attemptId'))
    into v_items
    from jsonb_array_elements(p_items) el;
  v_hash := encode(sha256(convert_to(v_items::text, 'UTF8')), 'hex');

  if v_op.status = 'accepted' then
    if v_op.payload_hash = v_hash then
      return jsonb_build_object('status', 'already_saved', 'operationId', v_op.id, 'seq', v_op.seq, 'count', v_op.item_count);
    end if;
    return jsonb_build_object('status', 'conflict', 'operationId', v_op.id);
  end if;

  insert into attempt_explanations (
    user_id, round_id, attempt_id, source, operation_id, seq,
    explanation, corrected_text, example_text, tip, prompt_version, model, created_at,
    note_kind, ref_attempt_id
  )
  select v_op.user_id, v_op.round_id, (el ->> 'attemptId')::uuid, v_op.kind, v_op.id, v_op.seq,
         el ->> 'explanation', el ->> 'correctedText', el ->> 'example', el ->> 'tip',
         v_op.prompt_version, v_op.model, clock_timestamp(),
         coalesce(el ->> 'kind', 'explanation'), (el ->> 'refAttemptId')::uuid
    from jsonb_array_elements(v_items) el;

  update explanation_operations
     set status = 'accepted', payload_hash = v_hash, item_count = v_n,
         lease_expires_at = null, finished_at = clock_timestamp()
   where id = v_op.id;

  return jsonb_build_object('status', 'saved', 'operationId', v_op.id, 'seq', v_op.seq, 'count', v_n);
end;
$$;

-- -------------------------------------------------------------------------
-- 3. Assessment storage
-- -------------------------------------------------------------------------
create table round_assessments (
  round_id                  uuid primary key references learning_sessions(id) on delete cascade,
  user_id                   uuid not null references users(id) on delete cascade,
  latest_started_generation integer not null default 0 check (latest_started_generation >= 0),
  accepted_generation       integer null,
  accepted_fingerprint      text null,
  accepted_prompt_version   integer null,
  accepted_model            text null,
  accepted_payload_hash     text null,
  accepted_payload          jsonb null,
  accepted_meta             jsonb null,
  accepted_at               timestamptz null,
  updated_at                timestamptz not null default clock_timestamp(),
  check ((accepted_generation is null) = (accepted_payload is null)),
  check (accepted_generation is null or (accepted_generation between 1 and latest_started_generation
         and accepted_fingerprint is not null and accepted_prompt_version is not null
         and accepted_model is not null and accepted_payload_hash is not null and accepted_at is not null))
);

comment on table round_assessments is
  'Learning Reports P5: the accepted AI assessment of a round (overview payload + meta, its learning-data fingerprint and content version). A started generation never changes it; only fn_assessment_finish does.';

create table assessment_generations (
  round_id         uuid not null references learning_sessions(id) on delete cascade,
  generation       integer not null check (generation > 0),
  user_id          uuid not null references users(id) on delete cascade,
  -- sha256 of the generation token: kept for the generation's whole life.
  token_hash       text not null,
  fingerprint      text not null,
  prompt_version   integer not null check (prompt_version > 0),
  model            text not null check (length(model) between 1 and 200),
  state            text not null default 'started' check (state in ('started', 'accepted', 'abandoned')),
  lease_expires_at timestamptz null,
  payload_hash     text null,
  abandon_reason   text null,
  created_at       timestamptz not null default clock_timestamp(),
  finished_at      timestamptz null,
  primary key (round_id, generation),
  check ((state = 'accepted') = (payload_hash is not null)),
  check (state = 'started' or lease_expires_at is null)
);

comment on table assessment_generations is
  'Learning Reports P5: one row per started assessment generation (ordering, lease, token hash). Owners may read its state columns; token_hash and payload_hash are not readable by any application role.';

alter table round_assessments enable row level security;
alter table assessment_generations enable row level security;
create policy "round_assessments_owner_select" on round_assessments
  for select to authenticated using (user_id = auth.uid());
create policy "assessment_generations_owner_select" on assessment_generations
  for select to authenticated using (user_id = auth.uid());

revoke all on round_assessments from public, anon, authenticated, service_role;
revoke all on assessment_generations from public, anon, authenticated, service_role;
grant select on round_assessments to authenticated, service_role;
-- Column-level: owners see generation state, never token/payload hashes.
grant select (round_id, generation, fingerprint, prompt_version, model, state, lease_expires_at, created_at, finished_at)
  on assessment_generations to authenticated;
grant select on assessment_generations to service_role;

-- -------------------------------------------------------------------------
-- 4. Legacy mirror of a new-format payload (pure)
--    {overview, strengths[{text}], priorities[{title, explanation, practice}], practicePlan[]}
--    → {verdict, strengths[], weaknesses[], recommendation}
-- -------------------------------------------------------------------------
create function fn_assessment_legacy_mirror(p_payload jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'verdict', coalesce(p_payload ->> 'overview', ''),
    'strengths', coalesce((select jsonb_agg(s ->> 'text') from jsonb_array_elements(
                   case when jsonb_typeof(p_payload -> 'strengths') = 'array' then p_payload -> 'strengths' else '[]'::jsonb end) s
                   where jsonb_typeof(s) = 'object' and s ->> 'text' is not null), '[]'::jsonb),
    'weaknesses', coalesce((select jsonb_agg(concat_ws(': ', p ->> 'title', p ->> 'explanation')) from jsonb_array_elements(
                   case when jsonb_typeof(p_payload -> 'priorities') = 'array' then p_payload -> 'priorities' else '[]'::jsonb end) p
                   where jsonb_typeof(p) = 'object'), '[]'::jsonb),
    'recommendation', coalesce(
       case when jsonb_typeof(p_payload -> 'practicePlan') = 'array' then p_payload -> 'practicePlan' ->> 0 end,
       case when jsonb_typeof(p_payload -> 'priorities') = 'array' then p_payload -> 'priorities' -> 0 ->> 'practice' end,
       '')
  );
$$;

-- -------------------------------------------------------------------------
-- 5. Generation RPCs
-- -------------------------------------------------------------------------

-- Starts (or declines to start) an overview generation.
--   pv older than the accepted one     → outdated_app (no spend)
--   accepted (fp, pv, model) all equal → reuse (no spend)
--   live lease, same (fp, pv, model)   → in_progress
--   live lease, anything else          → busy
--   otherwise                          → started{generation, token}
-- Never touches the accepted result or the legacy column.
create function fn_assessment_begin(
  p_user_id uuid,
  p_round_id uuid,
  p_fingerprint text,
  p_prompt_version integer,
  p_model text
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
  v_live assessment_generations%rowtype;
  v_gen integer;
  v_token uuid;
  v_expires timestamptz;
begin
  if p_user_id is null or p_round_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select user_id into v_owner from learning_sessions where id = p_round_id for no key update;
  if not found or v_owner is distinct from p_user_id then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
     or p_prompt_version is null or p_prompt_version < 1
     or p_model is null or length(btrim(p_model)) = 0 or length(p_model) > 200 then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  insert into round_assessments (round_id, user_id) values (p_round_id, p_user_id)
  on conflict (round_id) do nothing;
  select * into v_ra from round_assessments where round_id = p_round_id for update;

  if v_ra.accepted_generation is not null then
    if p_prompt_version < v_ra.accepted_prompt_version then
      return jsonb_build_object('status', 'outdated_app', 'acceptedPromptVersion', v_ra.accepted_prompt_version);
    end if;
    if v_ra.accepted_fingerprint = p_fingerprint and v_ra.accepted_prompt_version = p_prompt_version
       and v_ra.accepted_model = p_model then
      return jsonb_build_object('status', 'reuse', 'generation', v_ra.accepted_generation);
    end if;
  end if;

  if v_ra.latest_started_generation > 0 then
    select * into v_live from assessment_generations
     where round_id = p_round_id and generation = v_ra.latest_started_generation
       and state = 'started' and lease_expires_at > clock_timestamp()
     for update;
    if found then
      if v_live.fingerprint = p_fingerprint and v_live.prompt_version = p_prompt_version and v_live.model = p_model then
        return jsonb_build_object('status', 'in_progress', 'generation', v_live.generation);
      end if;
      return jsonb_build_object('status', 'busy');
    end if;
  end if;

  v_gen := v_ra.latest_started_generation + 1;
  v_token := gen_random_uuid();
  v_expires := clock_timestamp() + interval '120 seconds';
  insert into assessment_generations (round_id, generation, user_id, token_hash, fingerprint, prompt_version, model, state, lease_expires_at)
  values (p_round_id, v_gen, p_user_id, encode(sha256(convert_to(v_token::text, 'UTF8')), 'hex'),
          p_fingerprint, p_prompt_version, p_model, 'started', v_expires);
  update round_assessments set latest_started_generation = v_gen, updated_at = clock_timestamp()
   where round_id = p_round_id;

  return jsonb_build_object('status', 'started', 'generation', v_gen, 'token', v_token, 'leaseExpiresAt', v_expires);
end;
$$;

-- Accepts a generation's payload. Order of checks:
--   lock → generation of this user and round → TOKEN (always) → abandoned →
--   payload shape → canonical hash → (accepted) same hash: already_accepted,
--   else conflict → newer generation started: superseded → identity
--   (fp, pv, model) must equal the generation's → pv older than the
--   accepted one: outdated_app → accept + legacy mirror, in one transaction.
-- Late completion after lease expiry is accepted only while no newer
-- generation has started.
create function fn_assessment_finish(
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
  if p_fingerprint is distinct from v_g.fingerprint or p_prompt_version is distinct from v_g.prompt_version
     or p_model is distinct from v_g.model then
    return jsonb_build_object('status', 'invalid_identity');
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

create function fn_assessment_abandon(
  p_user_id uuid,
  p_round_id uuid,
  p_generation integer,
  p_token uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_g assessment_generations%rowtype;
begin
  if p_user_id is null or p_round_id is null or p_generation is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select user_id into v_owner from learning_sessions where id = p_round_id for no key update;
  if not found or v_owner is distinct from p_user_id then
    return jsonb_build_object('status', 'not_found');
  end if;
  perform 1 from round_assessments where round_id = p_round_id for update;
  select * into v_g from assessment_generations
   where round_id = p_round_id and generation = p_generation and user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_token is null or encode(sha256(convert_to(p_token::text, 'UTF8')), 'hex') <> v_g.token_hash then
    return jsonb_build_object('status', 'invalid_token');
  end if;
  if v_g.state = 'accepted' then
    return jsonb_build_object('status', 'already_accepted');
  end if;
  if v_g.state = 'started' then
    update assessment_generations
       set state = 'abandoned', lease_expires_at = null, finished_at = clock_timestamp(),
           abandon_reason = left(coalesce(nullif(btrim(p_reason), ''), 'unspecified'), 64)
     where round_id = p_round_id and generation = p_generation;
  end if;
  return jsonb_build_object('status', 'abandoned');
end;
$$;

-- -------------------------------------------------------------------------
-- 6. Legacy writer, guarded (same signature, same grants as 037)
-- -------------------------------------------------------------------------
create or replace function fn_persist_session_assessment(
  p_session_id uuid,
  p_user_id uuid,
  p_assessment jsonb
)
returns boolean
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
begin
  if p_session_id is null or p_user_id is null or p_assessment is null
     or jsonb_typeof(p_assessment) = 'null' or pg_column_size(p_assessment) > 65536 then
    raise exception 'invalid_payload';
  end if;
  -- Per-round lock first; the eligibility check below is a separate
  -- statement, so it sees anything a previous lock holder committed.
  select user_id into v_owner from learning_sessions where id = p_session_id for no key update;
  if not found or v_owner is distinct from p_user_id then
    return false;
  end if;
  -- A new-format assessment was ACCEPTED: the old writer may not replace it.
  if exists (select 1 from round_assessments where round_id = p_session_id and accepted_generation is not null) then
    return false;
  end if;
  -- Only the two assessment fields; never lifecycle/provenance/counters,
  -- and never updated_at (an AI assessment is not practice activity).
  update learning_sessions
     set ai_assessment = p_assessment, ai_assessment_generated_at = now()
   where id = p_session_id and user_id = p_user_id;
  return found;
end;
$$;

-- -------------------------------------------------------------------------
-- 7. Function privileges
-- -------------------------------------------------------------------------
revoke all on function fn_assessment_legacy_mirror(jsonb) from public, anon, authenticated, service_role;
revoke all on function fn_assessment_begin(uuid, uuid, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function fn_assessment_finish(uuid, uuid, integer, uuid, text, integer, text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function fn_assessment_abandon(uuid, uuid, integer, uuid, text) from public, anon, authenticated, service_role;
grant execute on function fn_assessment_begin(uuid, uuid, text, integer, text) to service_role;
grant execute on function fn_assessment_finish(uuid, uuid, integer, uuid, text, integer, text, jsonb, jsonb) to service_role;
grant execute on function fn_assessment_abandon(uuid, uuid, integer, uuid, text) to service_role;
-- create or replace keeps existing ACLs; restate them explicitly anyway.
revoke all on function fn_explanations_finish(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function fn_explanations_finish(uuid, uuid, uuid, uuid, jsonb) to service_role;
revoke all on function fn_persist_session_assessment(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function fn_persist_session_assessment(uuid, uuid, jsonb) to service_role;

commit;
