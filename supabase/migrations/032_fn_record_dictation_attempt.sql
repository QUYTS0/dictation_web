-- =====================================================
-- Phase 2 — fn_record_dictation_attempt (authoritative, created dormant)
--
-- Full logic per .claude/video-learning-management-plan.md §6.5/§8.12/§9.9:
-- lock the round, validate relationships, explicit idempotency
-- lookup-then-insert, conditional completion, all in one transaction.
--
-- **Dormant at the end of this migration**: EXECUTE is revoked from
-- PUBLIC, anon, authenticated, AND service_role, with no grant issued to
-- any application role. This function is fully specified and real, but
-- callable by nobody except the migration-owner connection (for isolated
-- integration testing) until the Phase 3 cutover runbook's own step
-- issues `grant execute ... to authenticated` — see PHASE2_RUNBOOK.md.
--
-- **Documented interface correction (Phase 2 task §6, "review the trust
-- boundary of every input"):** the plan's §8.12 pseudocode has the caller
-- supply `is_correct`/`error_type` directly. Once this function is
-- eventually granted to `authenticated` (Phase 3), any signed-in user
-- could call it directly via `.rpc()`, bypassing the Next.js route
-- entirely — a bare trusted `is_correct` boolean would let them fabricate
-- correctness for arbitrary text. `checkAnswer()`'s full grading pipeline
-- (src/lib/utils/text.ts) is not reimplemented here in full — its
-- word-diff/error-CLASSIFICATION half is display-only and never gates
-- credit or completion, so porting it would be an unjustified redesign of
-- something this plan asks to preserve, not fix. But the
-- CORRECTNESS-DETERMINING half (normalize, then compare) is cheap, pure,
-- and security-relevant, so it IS ported here (fn_normalize_dictation_text,
-- below) and the function recomputes `is_correct` itself from the
-- server-resolved segment text — it is never accepted as a bare input.
-- `p_error_type` remains an optional, informational parameter (it only
-- affects a UI label, never scoring/completion) but can never disagree
-- with the server-computed `is_correct` (forced to 'none' when correct,
-- falls back to a generic label when incorrect and the caller didn't
-- supply one) — see the function body for the exact rule.
-- =====================================================

-- ---------------------------------------------------------------
-- Private helper: faithful SQL port of the correctness-determining
-- subset of src/lib/utils/text.ts's normalizeText() (NOT the word-diff/
-- error-classification logic, which stays client/route-side and
-- display-only). Verified against representative strings in
-- src/__tests__/integration/phase2-schema.integration.test.ts.
-- ---------------------------------------------------------------
create or replace function fn_normalize_dictation_text(p_text text, p_mode text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text := coalesce(p_text, '');
begin
  -- normalizeSpecialChars: curly/smart punctuation -> plain ASCII, in the
  -- exact same order as the JS source.
  v_text := normalize(v_text, NFC);
  v_text := regexp_replace(v_text, '[' || chr(8216) || chr(8217) || chr(96) || chr(180) || ']', '''', 'g');
  v_text := regexp_replace(v_text, '[' || chr(8220) || chr(8221) || ']', '"', 'g');
  v_text := regexp_replace(v_text, chr(8211) || '|' || chr(8212), '-', 'g');
  v_text := replace(v_text, chr(8230), '...');
  -- normalizeWhitespace
  v_text := regexp_replace(btrim(v_text), '\s+', ' ', 'g');

  if p_mode in ('relaxed', 'learning') then
    -- removePunctuation: JS's `\w` with no /u flag is ASCII-only ([A-Za-z0-9_]);
    -- reproduced here as an explicit ASCII class (independent of DB locale/
    -- collation, which Postgres's own \w would NOT be) so behavior matches
    -- byte-for-byte regardless of server locale settings. Apostrophe is kept
    -- (matches JS's explicit `\s'` exception); underscore is excluded from
    -- the keep-set (matches JS's explicit `|_` removal, which overrides
    -- \w's normal inclusion of underscore).
    v_text := regexp_replace(v_text, '[^A-Za-z0-9\s'']', '', 'g');
    v_text := regexp_replace(v_text, '''\s', ' ', 'g');
    v_text := lower(v_text);
    v_text := regexp_replace(btrim(v_text), '\s+', ' ', 'g');
  end if;

  return v_text;
end;
$$;

revoke execute on function fn_normalize_dictation_text(text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------
-- Private helper: §6.4's {dictation, shadowing, overall} coverage object.
-- Guarded against p_required = 0 (§6.1 — 0/0 is undefined, not 100%; never
-- divides by zero, never auto-completes).
-- ---------------------------------------------------------------
create or replace function fn_round_coverage(p_round_id uuid, p_required integer)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_dictation integer;
  v_shadowing integer;
  v_overall integer;
begin
  select count(distinct segment_index) into v_dictation
    from attempt_logs where session_id = p_round_id and is_practice_valid;
  select count(distinct segment_index) into v_shadowing
    from shadowing_attempts where round_id = p_round_id and is_practice_valid;
  select count(distinct segment_index) into v_overall
    from (
      select segment_index from attempt_logs where session_id = p_round_id and is_practice_valid
      union
      select segment_index from shadowing_attempts where round_id = p_round_id and is_practice_valid
    ) u;

  return jsonb_build_object(
    'dictation', case when p_required > 0 then round(coalesce(v_dictation, 0)::numeric / p_required, 4) else 0 end,
    'shadowing', case when p_required > 0 then round(coalesce(v_shadowing, 0)::numeric / p_required, 4) else 0 end,
    'overall',   case when p_required > 0 then round(coalesce(v_overall, 0)::numeric / p_required, 4) else 0 end
  );
end;
$$;

revoke execute on function fn_round_coverage(uuid, integer) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------
-- fn_record_dictation_attempt
-- ---------------------------------------------------------------
create or replace function fn_record_dictation_attempt(
  p_round_id uuid,
  p_youtube_video_id text,
  p_segment_index integer,
  p_client_attempt_id uuid,
  p_user_text text,
  p_match_mode text default 'relaxed',
  p_error_type text default null,
  p_transcript_id uuid default null,
  p_study_session_id uuid default null,
  p_hint_level_used smallint default null
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
  v_normalized_expected text;
  v_normalized_user text;
  v_is_correct boolean;
  v_error_type text;
  v_is_practice_valid boolean;
  v_attempt record;
  v_was_inserted boolean := false;
  v_completed boolean := false;
begin
  if v_user_id is null then
    raise exception 'authentication_required';
  end if;
  if p_match_mode not in ('exact', 'relaxed', 'learning') then
    p_match_mode := 'relaxed';
  end if;

  -- 1. Lock the round row first, serializing concurrent submissions to the
  --    SAME round, and validate ownership/video in one statement (§9.7).
  select id, status, transcript_id, required_sentence_count into v_round
    from learning_sessions
    where id = p_round_id and user_id = v_user_id and youtube_video_id = p_youtube_video_id
    for update;
  if not found then
    raise exception 'round_not_found';
  end if;

  -- 2. Stale-revision check inside the lock (§9.5) — a round-based write's
  --    claimed transcriptId must match the round's immutable pin.
  if p_transcript_id is not null and p_transcript_id is distinct from v_round.transcript_id then
    raise exception 'stale_transcript_revision';
  end if;

  -- Segment identity resolved server-side from the pinned transcript, never
  -- trusted as a bare client-supplied FK (§9.7).
  select id, text_raw into v_segment
    from transcript_segments
    where transcript_id = v_round.transcript_id and segment_index = p_segment_index;
  if not found then
    raise exception 'segment_not_found';
  end if;

  -- Study-session relationship validation (§9.7): must belong to this
  -- user/video, and if it already has a round, that round must be this one
  -- — a stale studySessionId from a since-force-closed session is
  -- rejected, not silently reattached.
  if p_study_session_id is not null then
    perform 1 from study_sessions
      where id = p_study_session_id and user_id = v_user_id and youtube_video_id = p_youtube_video_id
        and (round_id is null or round_id = p_round_id);
    if not found then
      raise exception 'study_session_mismatch';
    end if;
  end if;

  -- 3. Idempotency lookup within scope, inside the round lock already held
  --    (safe as a plain SELECT — step 1 already serializes every writer).
  select * into v_existing from attempt_logs
    where session_id = p_round_id and segment_index = p_segment_index and client_attempt_id = p_client_attempt_id;

  -- Correctness recomputed server-side (see this file's header comment) —
  -- never trusted as a caller-supplied boolean.
  v_normalized_expected := fn_normalize_dictation_text(v_segment.text_raw, p_match_mode);
  v_normalized_user := fn_normalize_dictation_text(p_user_text, p_match_mode);
  v_is_correct := (v_normalized_expected = v_normalized_user);
  -- error_type is informational only and can never contradict is_correct.
  v_error_type := case when v_is_correct then 'none' else coalesce(nullif(p_error_type, ''), 'wrong_form') end;
  -- §6.2: practice-valid iff the submitted text is non-empty after trimming.
  v_is_practice_valid := (btrim(coalesce(p_user_text, '')) <> '');

  if found then
    if v_existing.expected_text is distinct from v_segment.text_raw
       or v_existing.user_text is distinct from p_user_text then
      raise exception 'idempotency_key_reused_with_different_payload';
    end if;
    -- Genuine retry — return the existing row untouched: no timestamp
    -- bump, no coverage recompute, no repeated side effect (§6.5).
    return jsonb_build_object(
      'attemptId', v_existing.id,
      'wasInserted', false,
      'isCorrect', v_existing.is_correct,
      'errorType', v_existing.error_type,
      'roundCompletedByThisRequest', false,
      'roundStatus', (select status from learning_sessions where id = p_round_id),
      'coverage', fn_round_coverage(p_round_id, v_round.required_sentence_count)
    );
  end if;

  -- 4. Absent: insert. The unique index (migration 024) remains a
  --    defense-in-depth backstop only — under normal operation this
  --    ON CONFLICT branch is unreachable, since step 1's lock already
  --    serializes every writer to this round.
  insert into attempt_logs (
    session_id, segment_index, expected_text, user_text,
    normalized_expected_text, normalized_user_text,
    is_correct, error_type, client_attempt_id, study_session_id,
    hint_level_used, is_practice_valid, transcript_id, segment_id,
    segment_identity_provenance
  ) values (
    p_round_id, p_segment_index, v_segment.text_raw, p_user_text,
    v_normalized_expected, v_normalized_user,
    v_is_correct, v_error_type, p_client_attempt_id, p_study_session_id,
    p_hint_level_used, v_is_practice_valid, v_round.transcript_id, v_segment.id,
    'verified'
  )
  on conflict (session_id, segment_index, client_attempt_id) do nothing
  returning * into v_attempt;

  if v_attempt.id is null then
    -- Backstop conflict with no visible row: resolve it like a genuine
    -- retry rather than fabricating a success with no backing row. Under
    -- step 1's lock this branch should be unreachable; if it is ever hit,
    -- fail loudly rather than silently.
    select * into v_attempt from attempt_logs
      where session_id = p_round_id and segment_index = p_segment_index and client_attempt_id = p_client_attempt_id;
    if v_attempt.id is null then
      raise exception 'attempt_insert_conflict_unresolved';
    end if;
    return jsonb_build_object(
      'attemptId', v_attempt.id,
      'wasInserted', false,
      'isCorrect', v_attempt.is_correct,
      'errorType', v_attempt.error_type,
      'roundCompletedByThisRequest', false,
      'roundStatus', (select status from learning_sessions where id = p_round_id),
      'coverage', fn_round_coverage(p_round_id, v_round.required_sentence_count)
    );
  end if;

  v_was_inserted := true;

  -- 5. Recompute coverage and conditionally complete, still holding the
  --    round's lock — only reachable for an active, not-yet-completed
  --    round with a positive required count, so a delayed request against
  --    an abandoned/completed round, or a zero-sentence video, can never
  --    trigger a (re-)completion.
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
    'isCorrect', v_attempt.is_correct,
    'errorType', v_attempt.error_type,
    'roundCompletedByThisRequest', v_completed,
    'roundStatus', (select status from learning_sessions where id = p_round_id),
    'coverage', fn_round_coverage(p_round_id, v_round.required_sentence_count)
  );
end;
$$;

-- Dormant: revoked from every application role, no grant issued (§9.9,
-- issue group 1 — see this file's header). anon named explicitly, not
-- only public/authenticated/service_role — Supabase's default per-schema
-- privileges grant anon its own separate EXECUTE on every newly created
-- function, which a PUBLIC-only revoke would not remove.
revoke execute on function fn_record_dictation_attempt(uuid, text, integer, uuid, text, text, text, uuid, uuid, smallint)
  from public, anon, authenticated, service_role;
