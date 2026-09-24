-- =====================================================
-- Phase 2 — fn_record_shadowing_attempt (authoritative, created dormant)
--
-- Mirrors fn_record_dictation_attempt's shape (migration 032) — lock,
-- validate, idempotency lookup-then-insert, conditional completion — for
-- shadowing_attempts. See .claude/video-learning-management-plan.md
-- §6.2/§6.5/§8.12/§9.9.
--
-- Trust boundary: unlike Dictation, Shadowing's practice-validity check
-- (§6.2: recording_duration_sec >= SHADOWING_MIN_DURATION_SEC) is a simple,
-- pure numeric comparison the function computes itself from the recording
-- duration — it never accepts a caller-supplied is_practice_valid boolean
-- at all (not merely re-validates one), so there is no fabrication vector
-- to close here the way Dictation's is_correct needed one.
--
-- **Dormant at the end of this migration**: EXECUTE revoked from PUBLIC,
-- anon, authenticated, AND service_role — no grant to any application
-- role until the Phase 3 cutover runbook's own step (PHASE2_RUNBOOK.md).
-- =====================================================

create or replace function fn_record_shadowing_attempt(
  p_round_id uuid,
  p_youtube_video_id text,
  p_segment_index integer,
  p_client_attempt_id uuid,
  p_recording_duration_sec numeric,
  p_transcript_id uuid default null,
  p_study_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_round record;
  v_segment record;
  v_existing record;
  v_is_practice_valid boolean;
  v_attempt record;
  v_completed boolean := false;
begin
  if v_user_id is null then
    raise exception 'authentication_required';
  end if;
  if p_recording_duration_sec is null or p_recording_duration_sec < 0 then
    raise exception 'invalid_recording_duration';
  end if;

  -- 1. Lock the round row, serializing concurrent submissions to the SAME
  --    round, and validate ownership/video in one statement (§9.7).
  select id, status, transcript_id, required_sentence_count into v_round
    from learning_sessions
    where id = p_round_id and user_id = v_user_id and youtube_video_id = p_youtube_video_id
    for update;
  if not found then
    raise exception 'round_not_found';
  end if;

  -- 2. Stale-revision check inside the lock (§9.5).
  if p_transcript_id is not null and p_transcript_id is distinct from v_round.transcript_id then
    raise exception 'stale_transcript_revision';
  end if;

  -- Segment identity resolved server-side (§9.7) — never a bare client FK.
  select id into v_segment
    from transcript_segments
    where transcript_id = v_round.transcript_id and segment_index = p_segment_index;
  if not found then
    raise exception 'segment_not_found';
  end if;

  if p_study_session_id is not null then
    perform 1 from study_sessions
      where id = p_study_session_id and user_id = v_user_id and youtube_video_id = p_youtube_video_id
        and (round_id is null or round_id = p_round_id);
    if not found then
      raise exception 'study_session_mismatch';
    end if;
  end if;

  -- 3. Idempotency lookup within scope, inside the round lock already held.
  select * into v_existing from shadowing_attempts
    where round_id = p_round_id and segment_index = p_segment_index and client_attempt_id = p_client_attempt_id;

  -- §6.2: computed here, never trusted as caller input.
  v_is_practice_valid := (p_recording_duration_sec >= 0.5);

  if found then
    if v_existing.recording_duration_sec is distinct from p_recording_duration_sec then
      raise exception 'idempotency_key_reused_with_different_payload';
    end if;
    return jsonb_build_object(
      'attemptId', v_existing.id,
      'wasInserted', false,
      'isPracticeValid', v_existing.is_practice_valid,
      'roundCompletedByThisRequest', false,
      'roundStatus', (select status from learning_sessions where id = p_round_id),
      'coverage', fn_round_coverage(p_round_id, v_round.required_sentence_count)
    );
  end if;

  -- 4. Absent: insert. Unique index (migration 025) is a defense-in-depth
  --    backstop only — unreachable in normal operation, since step 1's
  --    lock already serializes every writer to this round.
  insert into shadowing_attempts (
    user_id, round_id, study_session_id, youtube_video_id, transcript_id,
    segment_index, segment_id, client_attempt_id, recording_duration_sec,
    is_practice_valid, validity_basis
  ) values (
    v_user_id, p_round_id, p_study_session_id, p_youtube_video_id, v_round.transcript_id,
    p_segment_index, v_segment.id, p_client_attempt_id, p_recording_duration_sec,
    v_is_practice_valid, 'client_reported'
  )
  on conflict (round_id, segment_index, client_attempt_id) do nothing
  returning * into v_attempt;

  if v_attempt.id is null then
    select * into v_attempt from shadowing_attempts
      where round_id = p_round_id and segment_index = p_segment_index and client_attempt_id = p_client_attempt_id;
    if v_attempt.id is null then
      raise exception 'attempt_insert_conflict_unresolved';
    end if;
    return jsonb_build_object(
      'attemptId', v_attempt.id,
      'wasInserted', false,
      'isPracticeValid', v_attempt.is_practice_valid,
      'roundCompletedByThisRequest', false,
      'roundStatus', (select status from learning_sessions where id = p_round_id),
      'coverage', fn_round_coverage(p_round_id, v_round.required_sentence_count)
    );
  end if;

  -- 5. Recompute coverage and conditionally complete, still holding the lock.
  update learning_sessions
  set status = 'completed', completed_at = now()
  where id = p_round_id
    and status = 'active'
    and completed_at is null
    and required_sentence_count > 0
    and (
      select count(distinct segment_index) from (
        select segment_index from attempt_logs where session_id = p_round_id and is_practice_valid
        union
        select segment_index from shadowing_attempts where round_id = p_round_id and is_practice_valid
      ) u
    ) >= required_sentence_count;
  v_completed := found;

  return jsonb_build_object(
    'attemptId', v_attempt.id,
    'wasInserted', true,
    'isPracticeValid', v_attempt.is_practice_valid,
    'roundCompletedByThisRequest', v_completed,
    'roundStatus', (select status from learning_sessions where id = p_round_id),
    'coverage', fn_round_coverage(p_round_id, v_round.required_sentence_count)
  );
end;
$$;

revoke execute on function fn_record_shadowing_attempt(uuid, text, integer, uuid, numeric, uuid, uuid)
  from public, anon, authenticated, service_role;
