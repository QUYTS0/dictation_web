-- =====================================================
-- 043 — Saved explanations (Learning Reports P4)
--
-- Why a new table instead of fixing ai_feedback:
--   The pre-P4 explain-all writer runs
--     DELETE FROM ai_feedback WHERE attempt_id IN (...); INSERT ...;
--   as two separate statements (a DELETE error is only logged and the
--   INSERT still runs). A successful DELETE followed by a failed INSERT
--   leaves NO row. Old app instances can run during a deploy window or
--   after an app rollback, and the app cannot stop them — so anything
--   stored in ai_feedback can be deleted by old code. New explanations
--   are therefore stored in attempt_explanations, which no old code
--   references, and every ai_feedback row is COPIED there when it is
--   inserted (trigger) or already exists (backfill). attempt_explanations
--   deliberately has no foreign key to ai_feedback, so a legacy DELETE can
--   never cascade into it.
--
-- Contents:
--   1. explanation_operations — one row per provider operation (batch or
--      single). The order `seq` is allocated at BEGIN under the per-round
--      lock, so a late finish never outranks a newer operation.
--   2. attempt_explanations   — one row per saved note (new or legacy copy).
--   3. Legacy capture: AFTER INSERT trigger on ai_feedback + one-time
--      backfill, both inside this transaction under a SHARE ROW EXCLUSIVE
--      lock on ai_feedback (concurrent legacy INSERTs wait, then fire the
--      trigger — every row is copied exactly once).
--   4. fn_explanation_pattern_key — the versioned, match-mode-aware reuse
--      identity (mirrored in src/lib/practice/explanationIdentity.ts).
--   5. Service-role-only writer RPCs: fn_explanations_begin / _finish /
--      _abandon. Every one takes the per-round lock FIRST:
--        select … from learning_sessions where id = round for no key update
--   6. Operator-only catch-up: fn_copy_legacy_ai_feedback().
--
-- Nothing existing is altered or dropped: ai_feedback, its policies and
-- the legacy assessment path (fn_persist_session_assessment) are unchanged.
-- See .claude/learning-reports-review-plan.md §6 and
-- supabase/P4_EXPLANATIONS_RUNBOOK.md.
-- =====================================================

begin;

-- Freeze legacy writes for the whole capture install: inserts committed
-- before this lock are seen by the backfill below; inserts attempted after
-- it wait until COMMIT and then fire the trigger.
lock table ai_feedback in share row exclusive mode;

-- -------------------------------------------------------------------------
-- 1. Operations
-- -------------------------------------------------------------------------
create table explanation_operations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  round_id           uuid not null references learning_sessions(id) on delete cascade,
  seq                bigint not null check (seq > 0),
  kind               text not null check (kind in ('batch', 'single')),
  intent             text not null check (intent in ('missing', 'reexplain')),
  op_key             text not null,
  target_attempt_ids uuid[] not null check (cardinality(target_attempt_ids) between 1 and 35),
  prompt_version     integer not null check (prompt_version > 0),
  model              text not null check (length(model) between 1 and 200),
  status             text not null default 'started' check (status in ('started', 'accepted', 'abandoned')),
  -- sha256 of the operation token. Kept for the operation's whole life, so
  -- a repeated finish is authenticated even after the lease was cleared.
  token_hash         text not null,
  lease_expires_at   timestamptz null,
  payload_hash       text null,
  item_count         integer null,
  abandon_reason     text null,
  created_at         timestamptz not null default clock_timestamp(),
  finished_at        timestamptz null,
  unique (round_id, seq),
  check ((status = 'accepted') = (payload_hash is not null)),
  check (status = 'started' or lease_expires_at is null)
);
create index explanation_operations_live_idx on explanation_operations(round_id) where status = 'started';

comment on table explanation_operations is
  'Learning Reports P4: one row per explanation provider operation. seq is allocated at begin under the per-round lock and orders saved notes; token_hash authenticates every finish/abandon, including repeats after acceptance.';

-- -------------------------------------------------------------------------
-- 2. Saved notes
-- -------------------------------------------------------------------------
create table attempt_explanations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  round_id           uuid not null references learning_sessions(id) on delete cascade,
  attempt_id         uuid not null references attempt_logs(id) on delete cascade,
  source             text not null check (source in ('legacy_ai_feedback', 'batch', 'single')),
  operation_id       uuid null references explanation_operations(id) on delete cascade,
  seq                bigint null,
  -- The ai_feedback row this was copied from. NO foreign key on purpose:
  -- deleting the legacy row must never delete the copy.
  legacy_feedback_id uuid null unique,
  explanation        text not null check (btrim(explanation) <> ''),
  corrected_text     text null,
  example_text       text null,
  tip                text null,
  prompt_version     integer null,
  model              text null,
  -- For legacy copies: the ORIGINAL ai_feedback.created_at (ordering among
  -- legacy notes stays deterministic). For new notes: when it was saved.
  created_at         timestamptz not null,
  copied_at          timestamptz null,
  unique (operation_id, attempt_id),
  check ((source = 'legacy_ai_feedback') = (legacy_feedback_id is not null)),
  check (source <> 'legacy_ai_feedback'
         or (operation_id is null and seq is null and prompt_version is null and model is null and copied_at is not null)),
  check (source = 'legacy_ai_feedback'
         or (operation_id is not null and seq is not null and prompt_version is not null and model is not null))
);
create index attempt_explanations_round_idx on attempt_explanations(round_id);
create index attempt_explanations_attempt_idx on attempt_explanations(attempt_id);

comment on table attempt_explanations is
  'Learning Reports P4: saved AI explanations per attempt. Effective note of an attempt = first by (seq desc nulls last, created_at desc, id desc). Legacy ai_feedback rows are copied here (source=legacy_ai_feedback) and survive deletion of the source row.';

-- -------------------------------------------------------------------------
-- 3. Access: owner reads through RLS; writes only through the RPCs below
-- -------------------------------------------------------------------------
alter table explanation_operations enable row level security;
alter table attempt_explanations enable row level security;

create policy "attempt_explanations_owner_select" on attempt_explanations
  for select to authenticated using (user_id = auth.uid());

-- Supabase's default privileges grant ALL on new tables to every API role;
-- take them back explicitly.
revoke all on explanation_operations from public, anon, authenticated, service_role;
revoke all on attempt_explanations from public, anon, authenticated, service_role;
grant select on attempt_explanations to authenticated, service_role;
grant select on explanation_operations to service_role;

-- -------------------------------------------------------------------------
-- 4. Reuse identity (version p1)
--
-- Two attempts may share one explanation only when the round's grading
-- rule treats them as the same mistake: same match_mode AND the same
-- normalized (reference, answer) pair under THAT mode. exact keeps case and
-- punctuation; relaxed and learning are kept apart even though they
-- normalize alike today. An unknown (legacy null) mode has NO key: such an
-- attempt only ever shows the note attached to itself.
-- The byte-length prefix keeps the encoding unambiguous.
-- -------------------------------------------------------------------------
create function fn_explanation_pattern_key(p_expected text, p_user text, p_mode text)
returns text
language plpgsql
immutable
parallel safe
set search_path = public, pg_temp
as $$
declare
  v_e text;
  v_u text;
begin
  if p_mode is null or p_mode not in ('exact', 'relaxed', 'learning') or p_expected is null or p_user is null then
    return null;
  end if;
  v_e := fn_normalize_dictation_text(p_expected, p_mode);
  v_u := fn_normalize_dictation_text(p_user, p_mode);
  return encode(sha256(convert_to('p1|' || p_mode || '|' || octet_length(v_e) || '|' || v_e || '|' || v_u, 'UTF8')), 'hex');
end;
$$;

-- -------------------------------------------------------------------------
-- 5. Legacy capture
-- -------------------------------------------------------------------------

-- Copies ONE legacy row when it is usable; ownership comes only from the
-- authoritative attempt → round → user chain (never invented). Returns
-- true when a copy was inserted now, false when it already existed or the
-- row can't be copied (no attempt, blank explanation, round without owner)
-- — such rows stay in ai_feedback and are listed by the postflight.
create function fn_capture_legacy_feedback_row(
  p_feedback_id uuid,
  p_attempt_id uuid,
  p_explanation text,
  p_corrected_text text,
  p_example_text text,
  p_created_at timestamptz
)
returns boolean
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_round uuid;
  v_user uuid;
  v_rows integer;
begin
  if p_feedback_id is null or p_attempt_id is null or p_explanation is null or btrim(p_explanation) = '' then
    return false;
  end if;
  select a.session_id, s.user_id into v_round, v_user
    from attempt_logs a join learning_sessions s on s.id = a.session_id
   where a.id = p_attempt_id;
  if v_round is null or v_user is null then
    return false;
  end if;
  insert into attempt_explanations (
    user_id, round_id, attempt_id, source, legacy_feedback_id,
    explanation, corrected_text, example_text, created_at, copied_at
  ) values (
    v_user, v_round, p_attempt_id, 'legacy_ai_feedback', p_feedback_id,
    p_explanation, p_corrected_text, p_example_text, coalesce(p_created_at, clock_timestamp()), clock_timestamp()
  )
  on conflict (legacy_feedback_id) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Trigger body. A capture failure must NOT fail the legacy INSERT: an old
-- writer that already DELETEd would otherwise lose its row entirely. The
-- row stays in ai_feedback, the postflight reports it as uncopied, and
-- fn_copy_legacy_ai_feedback() can copy it later while it still exists.
create function fn_ai_feedback_capture()
returns trigger
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  begin
    perform fn_capture_legacy_feedback_row(new.id, new.attempt_id, new.explanation, new.corrected_text, new.example_text, new.created_at);
  exception when others then
    raise warning 'ai_feedback capture failed for %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

create trigger ai_feedback_capture
  after insert on ai_feedback
  for each row execute function fn_ai_feedback_capture();

-- Operator-only, idempotent catch-up (also the backfill below). It can
-- copy only rows that STILL EXIST in ai_feedback: a row inserted and
-- deleted while capture was disabled is gone and cannot be recovered.
create function fn_copy_legacy_ai_feedback()
returns jsonb
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_copied integer := 0;
  v_total integer := 0;
  r record;
begin
  for r in select id, attempt_id, explanation, corrected_text, example_text, created_at
             from ai_feedback order by created_at, id loop
    v_total := v_total + 1;
    if fn_capture_legacy_feedback_row(r.id, r.attempt_id, r.explanation, r.corrected_text, r.example_text, r.created_at) then
      v_copied := v_copied + 1;
    end if;
  end loop;
  return jsonb_build_object(
    'scanned', v_total,
    'copiedNow', v_copied,
    'present', (select count(*) from ai_feedback f where exists (select 1 from attempt_explanations e where e.legacy_feedback_id = f.id)),
    'notCopyable', (select count(*) from ai_feedback f where not exists (select 1 from attempt_explanations e where e.legacy_feedback_id = f.id))
  );
end;
$$;

-- One-time backfill of the rows that exist now (same function).
do $$
declare
  v jsonb;
begin
  v := fn_copy_legacy_ai_feedback();
  raise notice '043 legacy ai_feedback backfill: %', v;
end;
$$;

-- -------------------------------------------------------------------------
-- 6. Writer RPCs (service role only; per-round lock first)
-- -------------------------------------------------------------------------

-- Admits an operation. With intent 'missing' the targets that already have
-- a saved note (own, or a same-round attempt with the same pattern key) are
-- removed UNDER THE LOCK, so a request that raced a finished save never
-- pays for it again; nothing left → 'reuse' (no operation, no spend).
-- 'reexplain' is explicit user intent and keeps every target.
create function fn_explanations_begin(
  p_user_id uuid,
  p_round_id uuid,
  p_target_attempt_ids uuid[],
  p_kind text,
  p_intent text,
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
  v_n integer;
  v_remaining uuid[];
  v_covered uuid[];
  v_key text;
  v_live record;
  v_seq bigint;
  v_token uuid;
  v_id uuid;
  v_expires timestamptz;
begin
  if p_user_id is null or p_round_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  -- Per-round lock (shared by every AI writer).
  select user_id into v_owner from learning_sessions where id = p_round_id for no key update;
  if not found or v_owner is distinct from p_user_id then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_kind is null or p_kind not in ('batch', 'single')
     or p_intent is null or p_intent not in ('missing', 'reexplain')
     or p_prompt_version is null or p_prompt_version < 1
     or p_model is null or length(btrim(p_model)) = 0 or length(p_model) > 200 then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  v_n := coalesce(cardinality(p_target_attempt_ids), 0);
  if v_n < 1 or v_n > 35 or (p_kind = 'single' and v_n <> 1)
     or array_position(p_target_attempt_ids, null) is not null
     or (select count(distinct t) from unnest(p_target_attempt_ids) t) <> v_n
     or (select count(*) from attempt_logs a
          where a.id = any(p_target_attempt_ids) and a.session_id = p_round_id and a.is_correct = false) <> v_n then
    return jsonb_build_object('status', 'invalid_targets');
  end if;

  if p_intent = 'missing' then
    select coalesce(array_agg(t.id order by t.ord) filter (where not t.covered), '{}'),
           coalesce(array_agg(t.id order by t.ord) filter (where t.covered), '{}')
      into v_remaining, v_covered
      from (
        select u.id, u.ord,
               exists (select 1 from attempt_explanations e where e.attempt_id = u.id)
               or exists (
                 select 1
                   from attempt_explanations e
                   join attempt_logs a on a.id = e.attempt_id
                  where e.round_id = p_round_id
                    and fn_explanation_pattern_key(a.expected_text, a.user_text, a.match_mode)
                        = fn_explanation_pattern_key(ta.expected_text, ta.user_text, ta.match_mode)
               ) as covered
          from unnest(p_target_attempt_ids) with ordinality as u(id, ord)
          join attempt_logs ta on ta.id = u.id
      ) t;
    if cardinality(v_remaining) = 0 then
      return jsonb_build_object('status', 'reuse', 'covered', to_jsonb(v_covered), 'targets', '[]'::jsonb);
    end if;
  else
    v_remaining := p_target_attempt_ids;
    v_covered := '{}';
  end if;

  v_key := encode(sha256(convert_to(
             p_kind || '|' || p_intent || '|' || p_prompt_version || '|' || p_model || '|' ||
             (select string_agg(x::text, ',' order by x::text) from unnest(v_remaining) x), 'UTF8')), 'hex');

  -- One live operation per round: the same request is in progress, any
  -- other is busy. An expired lease no longer blocks (passive expiry).
  select id, op_key into v_live
    from explanation_operations
   where round_id = p_round_id and status = 'started' and lease_expires_at > clock_timestamp()
   order by seq desc
   limit 1;
  if found then
    if v_live.op_key = v_key then
      return jsonb_build_object('status', 'in_progress', 'operationId', v_live.id);
    end if;
    return jsonb_build_object('status', 'busy');
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq from explanation_operations where round_id = p_round_id;
  v_token := gen_random_uuid();
  v_expires := clock_timestamp() + interval '120 seconds';
  insert into explanation_operations (
    user_id, round_id, seq, kind, intent, op_key, target_attempt_ids,
    prompt_version, model, status, token_hash, lease_expires_at
  ) values (
    p_user_id, p_round_id, v_seq, p_kind, p_intent, v_key, v_remaining,
    p_prompt_version, p_model, 'started', encode(sha256(convert_to(v_token::text, 'UTF8')), 'hex'), v_expires
  )
  returning id into v_id;

  return jsonb_build_object(
    'status', 'started',
    'operationId', v_id,
    'token', v_token,
    'seq', v_seq,
    'targets', to_jsonb(v_remaining),
    'covered', to_jsonb(v_covered),
    'leaseExpiresAt', v_expires
  );
end;
$$;

-- Saves an operation's notes, all or nothing. Order of checks:
--   lock → operation of this user and round → TOKEN (always, even when the
--   operation is already accepted or its lease expired) → not abandoned →
--   payload validation → canonical hash → idempotency / conflict → insert.
-- p_items: [{attemptId, explanation, correctedText?, example?, tip?}], no
-- other keys, 1..cardinality(targets), unique attemptIds, all in targets,
-- non-blank explanation. An empty array is refused: a response with no
-- usable notes is ABANDONED by the caller, never "saved".
create function fn_explanations_finish(
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

  -- Shape.
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
               coalesce((select bool_and(k in ('attemptId', 'explanation', 'correctedText', 'example', 'tip'))
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

  -- Canonical representation: known keys only, explicit nulls, sorted by
  -- attempt id. jsonb's text form is deterministic for equal values.
  select jsonb_agg(jsonb_build_object(
           'attemptId', lower(el ->> 'attemptId'),
           'explanation', el ->> 'explanation',
           'correctedText', el ->> 'correctedText',
           'example', el ->> 'example',
           'tip', el ->> 'tip') order by lower(el ->> 'attemptId'))
    into v_items
    from jsonb_array_elements(p_items) el;
  v_hash := encode(sha256(convert_to(v_items::text, 'UTF8')), 'hex');

  if v_op.status = 'accepted' then
    if v_op.payload_hash = v_hash then
      return jsonb_build_object('status', 'already_saved', 'operationId', v_op.id, 'seq', v_op.seq, 'count', v_op.item_count);
    end if;
    return jsonb_build_object('status', 'conflict', 'operationId', v_op.id);
  end if;

  -- 'started' (live or expired — the token proved it): save everything.
  insert into attempt_explanations (
    user_id, round_id, attempt_id, source, operation_id, seq,
    explanation, corrected_text, example_text, tip, prompt_version, model, created_at
  )
  select v_op.user_id, v_op.round_id, (el ->> 'attemptId')::uuid, v_op.kind, v_op.id, v_op.seq,
         el ->> 'explanation', el ->> 'correctedText', el ->> 'example', el ->> 'tip',
         v_op.prompt_version, v_op.model, clock_timestamp()
    from jsonb_array_elements(v_items) el;

  update explanation_operations
     set status = 'accepted', payload_hash = v_hash, item_count = v_n,
         lease_expires_at = null, finished_at = clock_timestamp()
   where id = v_op.id;

  return jsonb_build_object('status', 'saved', 'operationId', v_op.id, 'seq', v_op.seq, 'count', v_n);
end;
$$;

-- Marks a started operation abandoned (provider/admission failure, or no
-- usable notes). Saved notes — this operation's or anyone's — are never
-- touched. Token-checked like finish.
create function fn_explanations_abandon(
  p_user_id uuid,
  p_round_id uuid,
  p_operation_id uuid,
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
  v_op explanation_operations%rowtype;
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
  if v_op.status = 'accepted' then
    return jsonb_build_object('status', 'already_saved');
  end if;
  if v_op.status = 'started' then
    update explanation_operations
       set status = 'abandoned', lease_expires_at = null, finished_at = clock_timestamp(),
           abandon_reason = left(coalesce(nullif(btrim(p_reason), ''), 'unspecified'), 64)
     where id = v_op.id;
  end if;
  return jsonb_build_object('status', 'abandoned');
end;
$$;

-- -------------------------------------------------------------------------
-- 7. Function privileges (exact signatures; PUBLIC's default EXECUTE and
--    Supabase's default grants revoked)
-- -------------------------------------------------------------------------
revoke all on function fn_explanation_pattern_key(text, text, text) from public, anon, authenticated, service_role;
revoke all on function fn_capture_legacy_feedback_row(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function fn_ai_feedback_capture() from public, anon, authenticated, service_role;
revoke all on function fn_copy_legacy_ai_feedback() from public, anon, authenticated, service_role;
revoke all on function fn_explanations_begin(uuid, uuid, uuid[], text, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function fn_explanations_finish(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function fn_explanations_abandon(uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

grant execute on function fn_explanations_begin(uuid, uuid, uuid[], text, text, integer, text) to service_role;
grant execute on function fn_explanations_finish(uuid, uuid, uuid, uuid, jsonb) to service_role;
grant execute on function fn_explanations_abandon(uuid, uuid, uuid, uuid, text) to service_role;

commit;
