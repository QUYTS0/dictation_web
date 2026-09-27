-- =====================================================
-- 038 — Phase 4: Shadowing server-side persistence (evaluation lifecycle)
--
-- Purely additive and compatible with the deployed Phase 3 application:
--   * no existing function, grant, policy or row is changed;
--   * shadowing_attempts gains four NULLABLE columns with no default
--     (catalog-only change; every existing row keeps NULL = "not recorded");
--   * new functions only — nothing the Phase 3 app calls is touched, so the
--     migration can (and must) be applied BEFORE the Phase 4 code deploys.
--
-- Practice credit itself is unchanged: fn_record_shadowing_attempt (037,
-- granted to authenticated at Phase 3 activation) still inserts the
-- attempt, decides is_practice_valid (duration >= 0.5s, validity_basis
-- 'client_reported') and owns completion. This migration adds what the
-- evaluation half needs and 035's fn_persist_azure_result /
-- fn_persist_word_match_result lack:
--   * ADMISSION — fn_begin_azure_evaluation allocates the next
--     azure_eval_request_seq and marks the attempt pending, atomically, and
--     returns the reference text resolved from the attempt's own pinned
--     segment (never client text);
--   * GUARDED COMPLETION — fn_finish_azure_evaluation writes a result only
--     for the matching (attempt, user, seq) and only from 'pending' (or a
--     late success over its own 'expired' failure); a newer request,
--     a repeated identical write and a conflicting write are reported,
--     never applied;
--   * CONCURRENCY-SAFE EXPIRY — fn_expire_azure_evaluation fails a pending
--     request only if it is still that seq and older than the timeout, so it
--     can never expire a newer request;
--   * WORD MATCH — fn_record_word_match stores a server-computed result
--     under its own word_match_request_seq, independent of Azure;
--   * READS — fn_get_shadowing_attempt / fn_shadowing_round_results
--     (SECURITY INVOKER, owner RLS applies) return stored results so a
--     reloaded page restores them without any local attempt id.
--
-- 035's fn_persist_azure_result / fn_persist_word_match_result are left
-- exactly as they are (still service_role-only, part of the verified
-- Phase 3 permission matrix) but are no longer called by the application.
--
-- The previously planned 038_fn_delete_transcript_revision (Script
-- Versions) is renumbered to 039 and remains NOT created.
-- =====================================================

alter table shadowing_attempts
  add column if not exists azure_evaluated_at timestamptz null,
  add column if not exists azure_detail jsonb null,
  add column if not exists word_match_evaluated_at timestamptz null,
  add column if not exists word_match_detail jsonb null;

comment on column shadowing_attempts.azure_detail is
  'Phase 4: per-word Azure detail ({recognizedText, words[]}) of the stored '
  'result, written only by fn_finish_azure_evaluation. Never the raw provider '
  'payload; never audio. NULL on rows evaluated before Phase 4 (none exist).';
comment on column shadowing_attempts.word_match_detail is
  'Phase 4: {recognizedText, problemWords[]} of the stored Word Match result. '
  'recognizedText is browser speech recognition output (client-derived — see '
  'PHASE4_RUNBOOK.md trust boundary); the scores are computed server-side.';

-- Pending evaluations older than this are reported (and lazily written) as
-- failed/'expired'. One definition for every reader and writer.
create or replace function fn_shadowing_eval_timeout_sec()
returns integer
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select 120;
$$;

-- -------------------------------------------------------------------------
-- Azure evaluation lifecycle (backend-only: service_role, called by
-- /api/practice/evaluate after it verified the caller with GoTrue; every
-- function re-checks (attempt, user) itself).
-- -------------------------------------------------------------------------

create or replace function fn_begin_azure_evaluation(p_attempt_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
  v_round record;
  v_seg record;
  v_seq integer;
begin
  if p_attempt_id is null or p_user_id is null then raise exception 'invalid_payload'; end if;

  select * into v from shadowing_attempts where id = p_attempt_id and user_id = p_user_id for update;
  if not found then raise exception 'attempt_not_found'; end if;

  -- Relationships, not just row ownership: the attempt's round is the
  -- caller's, for the same video, pinned to the attempt's revision, and the
  -- attempt's segment is that revision's sentence at that index.
  select user_id, youtube_video_id, transcript_id into v_round from learning_sessions where id = v.round_id;
  if not found or v_round.user_id <> p_user_id or v_round.youtube_video_id <> v.youtube_video_id
     or v.transcript_id is null or v_round.transcript_id is distinct from v.transcript_id then
    raise exception 'attempt_relationship_invalid';
  end if;
  select text_raw, transcript_id, segment_index into v_seg from transcript_segments where id = v.segment_id;
  if not found or v_seg.transcript_id <> v.transcript_id or v_seg.segment_index <> v.segment_index
     or btrim(coalesce(v_seg.text_raw, '')) = '' then
    raise exception 'reference_unavailable';
  end if;

  -- A recording too short to count as practice is not worth a paid call.
  if not v.is_practice_valid then raise exception 'attempt_not_evaluable'; end if;
  -- One successful evaluation per recording: re-scoring the same audio
  -- would only spend quota. A new take is a new attempt.
  if v.azure_eval_status = 'completed' then raise exception 'azure_already_evaluated'; end if;

  -- Admission: the next seq supersedes any earlier request for this attempt.
  update shadowing_attempts
     set azure_eval_request_seq = azure_eval_request_seq + 1,
         azure_eval_status = 'pending',
         eval_requested_at = clock_timestamp(),
         azure_error_reason = null,
         updated_at = now()
   where id = v.id
   returning azure_eval_request_seq into v_seq;

  return jsonb_build_object(
    'attemptId', v.id, 'seq', v_seq, 'referenceText', v_seg.text_raw,
    'recordingDurationSec', v.recording_duration_sec, 'roundId', v.round_id,
    'segmentIndex', v.segment_index, 'transcriptId', v.transcript_id, 'youtubeVideoId', v.youtube_video_id
  );
end;
$$;

create or replace function fn_finish_azure_evaluation(
  p_attempt_id uuid,
  p_user_id uuid,
  p_seq integer,
  p_status text,
  p_pronunciation_score numeric default null,
  p_accuracy_score numeric default null,
  p_fluency_score numeric default null,
  p_completeness_score numeric default null,
  p_prosody_score numeric default null,
  p_detail jsonb default null,
  p_error_reason text default null,
  p_engine_version text default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
  v_apply boolean := false;
begin
  if p_attempt_id is null or p_user_id is null or p_seq is null or p_seq < 1
     or p_status is null or p_status not in ('completed', 'failed') then
    raise exception 'invalid_payload';
  end if;
  if p_status = 'completed' and (
       p_pronunciation_score is null
       or p_pronunciation_score not between 0 and 100
       or (p_accuracy_score is not null and p_accuracy_score not between 0 and 100)
       or (p_fluency_score is not null and p_fluency_score not between 0 and 100)
       or (p_completeness_score is not null and p_completeness_score not between 0 and 100)
       or (p_prosody_score is not null and p_prosody_score not between 0 and 100)
       or (p_detail is not null and (jsonb_typeof(p_detail) <> 'object' or pg_column_size(p_detail) > 131072))
     ) then
    raise exception 'invalid_payload';
  end if;

  select * into v from shadowing_attempts where id = p_attempt_id and user_id = p_user_id for update;
  if not found then raise exception 'attempt_not_found'; end if;

  if v.azure_eval_request_seq <> p_seq then
    return jsonb_build_object('applied', false, 'outcome', 'superseded',
      'currentSeq', v.azure_eval_request_seq, 'status', v.azure_eval_status);
  end if;

  if v.azure_eval_status = 'pending' then
    v_apply := true;
  elsif v.azure_eval_status = 'failed' and v.azure_error_reason = 'expired' and p_status = 'completed' then
    -- The newest request came back after the read path expired it: a real,
    -- paid result for the current seq still wins over the timeout marker.
    v_apply := true;
  elsif v.azure_eval_status = 'completed' and p_status = 'completed'
        and v.azure_pronunciation_score is not distinct from p_pronunciation_score
        and v.azure_accuracy_score is not distinct from p_accuracy_score
        and v.azure_fluency_score is not distinct from p_fluency_score
        and v.azure_completeness_score is not distinct from p_completeness_score
        and v.azure_prosody_score is not distinct from p_prosody_score then
    -- A repeated write of the same result (e.g. a replayed recovery token).
    return jsonb_build_object('applied', false, 'outcome', 'already_applied', 'currentSeq', p_seq, 'status', 'completed');
  elsif v.azure_eval_status = 'failed' and p_status = 'failed' then
    return jsonb_build_object('applied', false, 'outcome', 'already_applied', 'currentSeq', p_seq, 'status', 'failed');
  end if;

  if not v_apply then
    -- e.g. a failure arriving after this seq already completed: the stored
    -- result is kept.
    return jsonb_build_object('applied', false, 'outcome', 'conflict', 'currentSeq', p_seq, 'status', v.azure_eval_status);
  end if;

  update shadowing_attempts
     set azure_eval_status = p_status,
         azure_pronunciation_score = case when p_status = 'completed' then p_pronunciation_score end,
         azure_accuracy_score = case when p_status = 'completed' then p_accuracy_score end,
         azure_fluency_score = case when p_status = 'completed' then p_fluency_score end,
         azure_completeness_score = case when p_status = 'completed' then p_completeness_score end,
         azure_prosody_score = case when p_status = 'completed' then p_prosody_score end,
         azure_detail = case when p_status = 'completed' then p_detail end,
         azure_evaluated_at = case when p_status = 'completed' then clock_timestamp() end,
         azure_error_reason = case when p_status = 'failed' then left(coalesce(p_error_reason, 'evaluation_failed'), 500) end,
         engine_version = coalesce(p_engine_version, engine_version),
         updated_at = now()
   where id = v.id;

  return jsonb_build_object('applied', true, 'outcome', 'applied', 'currentSeq', p_seq, 'status', p_status);
end;
$$;

create or replace function fn_expire_azure_evaluation(p_attempt_id uuid, p_user_id uuid, p_seq integer)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  if p_attempt_id is null or p_user_id is null or p_seq is null then raise exception 'invalid_payload'; end if;
  -- Only THIS seq, only while still pending, only once it is overdue — a
  -- newer request (higher seq) or a result that already landed is never hit.
  update shadowing_attempts
     set azure_eval_status = 'failed', azure_error_reason = 'expired', updated_at = now()
   where id = p_attempt_id and user_id = p_user_id and azure_eval_request_seq = p_seq
     and azure_eval_status = 'pending'
     and eval_requested_at < clock_timestamp() - make_interval(secs => fn_shadowing_eval_timeout_sec());
  return jsonb_build_object('expired', found);
end;
$$;

-- -------------------------------------------------------------------------
-- Word Match (backend-only). The route resolves the pinned reference text
-- and computes the scores itself from the recognized text; this function
-- only stores them under the independent word_match_request_seq.
-- -------------------------------------------------------------------------

create or replace function fn_record_word_match(
  p_attempt_id uuid,
  p_user_id uuid,
  p_status text,
  p_accuracy numeric default null,
  p_completeness numeric default null,
  p_detail jsonb default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v record;
  v_seq integer;
begin
  if p_attempt_id is null or p_user_id is null or p_status is null
     or p_status not in ('completed', 'failed', 'unsupported')
     or (p_status = 'completed' and (p_accuracy is null or p_completeness is null
         or p_accuracy not between 0 and 100 or p_completeness not between 0 and 100))
     or (p_detail is not null and (jsonb_typeof(p_detail) <> 'object' or pg_column_size(p_detail) > 32768)) then
    raise exception 'invalid_payload';
  end if;

  select * into v from shadowing_attempts where id = p_attempt_id and user_id = p_user_id for update;
  if not found then raise exception 'attempt_not_found'; end if;

  if v.word_match_status = 'completed' then
    -- One recording has one recognition result: an identical resubmission
    -- is a retry, anything else would rewrite history.
    if p_status = 'completed' and v.word_match_accuracy = p_accuracy and v.word_match_completeness = p_completeness
       and v.word_match_detail is not distinct from p_detail then
      return jsonb_build_object('applied', false, 'outcome', 'already_applied', 'seq', v.word_match_request_seq, 'status', 'completed');
    end if;
    raise exception 'word_match_already_recorded';
  end if;
  if v.word_match_status = p_status then
    return jsonb_build_object('applied', false, 'outcome', 'already_applied', 'seq', v.word_match_request_seq, 'status', p_status);
  end if;

  update shadowing_attempts
     set word_match_request_seq = word_match_request_seq + 1,
         word_match_status = p_status,
         word_match_accuracy = case when p_status = 'completed' then p_accuracy end,
         word_match_completeness = case when p_status = 'completed' then p_completeness end,
         word_match_detail = p_detail,
         word_match_evaluated_at = clock_timestamp(),
         updated_at = now()
   where id = v.id
   returning word_match_request_seq into v_seq;

  return jsonb_build_object('applied', true, 'outcome', 'applied', 'seq', v_seq, 'status', p_status);
end;
$$;

-- -------------------------------------------------------------------------
-- Reads (SECURITY INVOKER: the caller's own owner-SELECT RLS applies).
-- -------------------------------------------------------------------------

create or replace function fn_shadowing_attempt_dto(a shadowing_attempts, p_with_detail boolean)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'attemptId', a.id,
    'clientAttemptId', a.client_attempt_id,
    'roundId', a.round_id,
    'youtubeVideoId', a.youtube_video_id,
    'transcriptId', a.transcript_id,
    'segmentIndex', a.segment_index,
    'createdAt', a.created_at,
    'recordingDurationSec', a.recording_duration_sec,
    'isPracticeValid', a.is_practice_valid,
    'validityBasis', a.validity_basis,
    'studySessionId', a.study_session_id,
    'azure', jsonb_build_object(
      'status', case when x.expired then 'failed' else a.azure_eval_status end,
      'seq', a.azure_eval_request_seq,
      'requestedAt', a.eval_requested_at,
      'evaluatedAt', a.azure_evaluated_at,
      'pronunciationScore', a.azure_pronunciation_score,
      'accuracyScore', a.azure_accuracy_score,
      'fluencyScore', a.azure_fluency_score,
      'completenessScore', a.azure_completeness_score,
      'prosodyScore', a.azure_prosody_score,
      'errorReason', case when x.expired then 'expired' else a.azure_error_reason end,
      'engineVersion', a.engine_version,
      'detail', case when p_with_detail then a.azure_detail end
    ),
    'wordMatch', jsonb_build_object(
      'status', a.word_match_status,
      'seq', a.word_match_request_seq,
      'accuracy', a.word_match_accuracy,
      'completeness', a.word_match_completeness,
      'evaluatedAt', a.word_match_evaluated_at,
      'detail', case when p_with_detail then a.word_match_detail end
    )
  )
  from (select a.azure_eval_status = 'pending'
               and a.eval_requested_at < now() - make_interval(secs => fn_shadowing_eval_timeout_sec()) as expired) x;
$$;

create or replace function fn_get_shadowing_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v shadowing_attempts;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  select * into v from shadowing_attempts where id = p_attempt_id and user_id = auth.uid();
  if not found then raise exception 'attempt_not_found'; end if;
  return fn_shadowing_attempt_dto(v, true);
end;
$$;

-- Everything the practice page needs to restore a round's Shadowing state,
-- bounded by the round: per practiced sentence, the three independent
-- "latest" pointers (§6.7 — chronological, never best score) plus at most
-- five compact successful Azure results for the trend display.
create or replace function fn_shadowing_round_results(p_round_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_round record;
  v_segments jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  select id, youtube_video_id, transcript_id, status into v_round
    from learning_sessions where id = p_round_id and user_id = v_user;
  if not found then raise exception 'round_not_found'; end if;

  select coalesce(jsonb_agg(seg.body order by seg.segment_index), '[]'::jsonb) into v_segments
  from (
    select s.segment_index, jsonb_build_object(
      'segmentIndex', s.segment_index,
      'attemptCount', s.attempt_count,
      'latestAttempt', (
        select fn_shadowing_attempt_dto(x, false) from shadowing_attempts x
         where x.round_id = p_round_id and x.user_id = v_user and x.segment_index = s.segment_index
         order by x.created_at desc, x.id desc limit 1),
      'latestSuccessfulAzureAttempt', (
        select fn_shadowing_attempt_dto(x, true) from shadowing_attempts x
         where x.round_id = p_round_id and x.user_id = v_user and x.segment_index = s.segment_index
           and x.azure_eval_status = 'completed'
         order by x.created_at desc, x.id desc limit 1),
      'latestWordMatchAttempt', (
        select fn_shadowing_attempt_dto(x, true) from shadowing_attempts x
         where x.round_id = p_round_id and x.user_id = v_user and x.segment_index = s.segment_index
           and x.word_match_status = 'completed'
         order by x.created_at desc, x.id desc limit 1),
      'azureHistory', (
        select coalesce(jsonb_agg(h.item order by h.created_at, h.id), '[]'::jsonb) from (
          select x.id, x.created_at, jsonb_build_object(
            'attemptId', x.id, 'createdAt', x.created_at, 'evaluatedAt', x.azure_evaluated_at,
            'pronunciationScore', x.azure_pronunciation_score, 'accuracyScore', x.azure_accuracy_score,
            'fluencyScore', x.azure_fluency_score, 'completenessScore', x.azure_completeness_score,
            'prosodyScore', x.azure_prosody_score,
            'words', coalesce((
              select jsonb_agg(jsonb_build_object('word', w->'word', 'accuracyScore', w->'accuracyScore', 'errorType', w->'errorType'))
                from jsonb_array_elements(case when jsonb_typeof(x.azure_detail->'words') = 'array' then x.azure_detail->'words' else '[]'::jsonb end) w
            ), '[]'::jsonb)
          ) as item
          from shadowing_attempts x
          where x.round_id = p_round_id and x.user_id = v_user and x.segment_index = s.segment_index
            and x.azure_eval_status = 'completed'
          order by x.created_at desc, x.id desc limit 5
        ) h)
    ) as body
    from (
      select segment_index, count(*) as attempt_count
        from shadowing_attempts where round_id = p_round_id and user_id = v_user
       group by segment_index
    ) s
  ) seg;

  return jsonb_build_object(
    'roundId', v_round.id,
    'youtubeVideoId', v_round.youtube_video_id,
    'transcriptId', v_round.transcript_id,
    'roundStatus', v_round.status,
    'evaluationTimeoutSec', fn_shadowing_eval_timeout_sec(),
    'segments', v_segments
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Privileges (exact signatures). Supabase default privileges grant new
-- functions to anon/authenticated/service_role individually, so revoke
-- from each first.
-- -------------------------------------------------------------------------

revoke execute on function fn_shadowing_eval_timeout_sec() from public, anon, authenticated, service_role;
revoke execute on function fn_begin_azure_evaluation(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function fn_finish_azure_evaluation(uuid, uuid, integer, text, numeric, numeric, numeric, numeric, numeric, jsonb, text, text) from public, anon, authenticated, service_role;
revoke execute on function fn_expire_azure_evaluation(uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke execute on function fn_record_word_match(uuid, uuid, text, numeric, numeric, jsonb) from public, anon, authenticated, service_role;
revoke execute on function fn_shadowing_attempt_dto(shadowing_attempts, boolean) from public, anon, authenticated, service_role;
revoke execute on function fn_get_shadowing_attempt(uuid) from public, anon, authenticated, service_role;
revoke execute on function fn_shadowing_round_results(uuid) from public, anon, authenticated, service_role;

-- Backend-only writers.
grant execute on function fn_begin_azure_evaluation(uuid, uuid) to service_role;
grant execute on function fn_finish_azure_evaluation(uuid, uuid, integer, text, numeric, numeric, numeric, numeric, numeric, jsonb, text, text) to service_role;
grant execute on function fn_expire_azure_evaluation(uuid, uuid, integer) to service_role;
grant execute on function fn_record_word_match(uuid, uuid, text, numeric, numeric, jsonb) to service_role;

-- Owner reads (SECURITY INVOKER → the caller's RLS). The helpers they call
-- run with the caller's privileges, so authenticated needs them too; they
-- only format rows the caller can already SELECT.
grant execute on function fn_shadowing_eval_timeout_sec() to authenticated;
grant execute on function fn_shadowing_attempt_dto(shadowing_attempts, boolean) to authenticated;
grant execute on function fn_get_shadowing_attempt(uuid) to authenticated;
grant execute on function fn_shadowing_round_results(uuid) to authenticated;
