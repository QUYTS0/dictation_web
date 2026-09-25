-- =====================================================
-- Phase 2 — Round lifecycle (dormant), study session / activity flush,
-- provider-result persistence, and the three temporary legacy bridges.
--
-- Renumbered from the plan's original "033" (see PHASE2_RUNBOOK.md for the
-- full old-number -> new-number mapping this Phase 2 pass introduced).
--
-- Every function here is SECURITY DEFINER, owned by the migration-applying
-- role, with an explicit pinned search_path. Execution identity, exactly
-- per .claude/video-learning-management-plan.md §9.9, distinguishing the
-- three genuinely different cases (not one blanket rule):
--   - User-actor functions (fn_get_or_create_study_session,
--     fn_flush_study_activity, fn_legacy_save_progress,
--     fn_legacy_restart_round): called via the caller's OWN
--     RLS-respecting client. The database ROLE for such a connection is
--     `authenticated`, and the request carries the caller's real JWT, so
--     `auth.uid()` genuinely resolves to the signed-in end user inside the
--     function body -- identity is derived there, never from a request
--     parameter.
--   - Backend-only functions (fn_persist_azure_result,
--     fn_persist_word_match_result, fn_legacy_record_dictation_attempt):
--     called via the SERVICE-ROLE client. The database role for that
--     connection is `service_role`; a service-role connection's JWT still
--     carries claims (an `apikey`/service-role JWT with `role:
--     "service_role"`), but no *end-user* identity claim -- `auth.uid()`
--     evaluates to NULL under it, which is a different fact from "carries
--     no claims at all". These functions never call auth.uid() for that
--     reason; the route that calls them has ALREADY verified the real
--     end-user and their ownership of the target row using the caller's
--     own RLS-respecting client, BEFORE switching to the service-role
--     client to make this call -- the function receives that
--     already-verified identity only as a trusted parameter (e.g.
--     `session_id`), never re-derives or infers it from the service-role
--     connection itself.
--   - Dormant authoritative functions (fn_create_or_get_active_round,
--     fn_update_resume_position, fn_restart_round): fully specified,
--     `authenticated`-shaped bodies, but EXECUTE is revoked from every
--     application role including service_role at the end of this
--     migration -- see the grants block at the bottom.
--
-- See .claude/video-learning-management-plan.md §5.3/§6.3/§6.3b/§8.13/§9.6/§9.9.
-- =====================================================

-- =========================================================================
-- Private helpers (never directly callable by any application role — see
-- the revoke block at the end of this migration)
-- =========================================================================

create or replace function fn_check_write_gate()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_paused boolean;
begin
  -- FOR SHARE, held until the calling transaction finishes (this function
  -- always runs inside the same transaction as its caller's function body
  -- — a plpgsql function never opens/commits its own sub-transaction) —
  -- this is what makes "the gate check and all related writes execute in
  -- the same database transaction" true, not merely a separate check that
  -- happens to run first.
  select completion_writes_paused into v_paused
    from app_write_gate where id = 1
    for share;
  if not found then
    raise exception 'write_gate_missing';
  end if;
  if v_paused then
    raise exception 'write_gate_paused';
  end if;
end;
$$;

create or replace function fn_eligible_segment_count(p_transcript_id uuid)
returns integer
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select count(*)::integer from transcript_segments
    where transcript_id = p_transcript_id and text_normalized <> '';
$$;

-- Merges a jsonb array of {"start":num,"end":num} into a sorted,
-- non-overlapping array — TRUE overlap/touching only, never a tolerance
-- window (§6.3). Degenerate entries (null/negative/end<=start) are
-- dropped defensively; fn_flush_study_activity validates the raw payload
-- BEFORE calling this, so a caller reaching this with bad data has
-- already been rejected upstream — this is a second, independent safety
-- net, not the primary validation.
create or replace function fn_merge_intervals(p_intervals jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_result jsonb := '[]'::jsonb;
  v_cur_start numeric;
  v_cur_end numeric;
  v_rec record;
  v_first boolean := true;
begin
  if p_intervals is null or jsonb_typeof(p_intervals) <> 'array' then
    return '[]'::jsonb;
  end if;

  for v_rec in
    select (elem->>'start')::numeric as s, (elem->>'end')::numeric as e
    from jsonb_array_elements(p_intervals) as elem
    order by (elem->>'start')::numeric, (elem->>'end')::numeric
  loop
    if v_rec.s is null or v_rec.e is null or v_rec.e <= v_rec.s or v_rec.s < 0 then
      continue;
    end if;
    if v_first then
      v_cur_start := v_rec.s; v_cur_end := v_rec.e; v_first := false;
    elsif v_rec.s <= v_cur_end then
      v_cur_end := greatest(v_cur_end, v_rec.e);
    else
      v_result := v_result || jsonb_build_array(jsonb_build_object('start', v_cur_start, 'end', v_cur_end));
      v_cur_start := v_rec.s; v_cur_end := v_rec.e;
    end if;
  end loop;
  if not v_first then
    v_result := v_result || jsonb_build_array(jsonb_build_object('start', v_cur_start, 'end', v_cur_end));
  end if;
  return v_result;
end;
$$;

create or replace function fn_intervals_union_length(p_intervals jsonb)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(sum((elem->>'end')::numeric - (elem->>'start')::numeric), 0)
  from jsonb_array_elements(fn_merge_intervals(p_intervals)) as elem;
$$;

-- Set intersection of two ALREADY-MERGED (sorted, non-overlapping)
-- interval arrays — a standard two-pointer sweep.
create or replace function fn_intervals_intersect(p_a jsonb, p_b jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  a jsonb := fn_merge_intervals(p_a);
  b jsonb := fn_merge_intervals(p_b);
  i integer := 0;
  j integer := 0;
  na integer := jsonb_array_length(fn_merge_intervals(p_a));
  nb integer := jsonb_array_length(fn_merge_intervals(p_b));
  lo numeric; hi numeric;
  ai_s numeric; ai_e numeric; bj_s numeric; bj_e numeric;
  result jsonb := '[]'::jsonb;
begin
  while i < na and j < nb loop
    ai_s := (a->i->>'start')::numeric; ai_e := (a->i->>'end')::numeric;
    bj_s := (b->j->>'start')::numeric; bj_e := (b->j->>'end')::numeric;
    lo := greatest(ai_s, bj_s);
    hi := least(ai_e, bj_e);
    if lo < hi then
      result := result || jsonb_build_array(jsonb_build_object('start', lo, 'end', hi));
    end if;
    if ai_e < bj_e then i := i + 1; else j := j + 1; end if;
  end loop;
  return result;
end;
$$;

-- §6.1/§6.3's eligibility rule, reused as the coverage denominator basis.
create or replace function fn_transcript_valid_union(p_transcript_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select fn_merge_intervals(
    coalesce(jsonb_agg(jsonb_build_object('start', start_sec, 'end', end_sec)), '[]'::jsonb)
  )
  from transcript_segments
  where transcript_id = p_transcript_id and end_sec > start_sec and text_normalized <> '';
$$;

-- =========================================================================
-- fn_create_or_get_active_round / fn_update_resume_position /
-- fn_restart_round — authoritative, DORMANT (revoked from every role
-- including service_role at the end of this migration; grant issued for
-- the first time only by the Phase 3 cutover runbook)
-- =========================================================================

create or replace function fn_create_or_get_active_round(p_youtube_video_id text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_round record;
  v_transcript_id uuid;
  v_required integer;
  v_round_number integer;
  v_new_id uuid;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;

  -- One consistent lock ordering across every cooperating round-lifecycle
  -- function (this one, fn_restart_round, fn_legacy_save_progress,
  -- fn_legacy_restart_round): always the advisory lock on (user, video)
  -- first, before touching learning_sessions — including the case where
  -- no row exists yet, which a row-level lock alone could never cover.
  perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || p_youtube_video_id));

  select id, transcript_id, round_number, required_sentence_count into v_round
    from learning_sessions
    where user_id = v_user_id and youtube_video_id = p_youtube_video_id and status = 'active'
    order by updated_at desc limit 1;

  if found then
    return jsonb_build_object(
      'roundId', v_round.id, 'created', false, 'transcriptId', v_round.transcript_id,
      'roundNumber', v_round.round_number, 'requiredSentenceCount', v_round.required_sentence_count
    );
  end if;

  -- Server-resolved current, ready transcript — never a client-supplied
  -- transcriptId, closing the pre-existing save-progress/route.ts gap.
  select id into v_transcript_id from transcripts
    where youtube_video_id = p_youtube_video_id and language = 'en'
      and is_current = true and status = 'ready';
  if v_transcript_id is null then raise exception 'transcript_not_ready'; end if;

  v_required := fn_eligible_segment_count(v_transcript_id);
  select coalesce(max(round_number), 0) + 1 into v_round_number
    from learning_sessions where user_id = v_user_id and youtube_video_id = p_youtube_video_id;

  insert into learning_sessions (
    user_id, youtube_video_id, transcript_id, status, provenance, round_number, required_sentence_count
  ) values (
    v_user_id, p_youtube_video_id, v_transcript_id, 'active', 'current', v_round_number, v_required
  ) returning id into v_new_id;

  return jsonb_build_object(
    'roundId', v_new_id, 'created', true, 'transcriptId', v_transcript_id,
    'roundNumber', v_round_number, 'requiredSentenceCount', v_required
  );
end;
$$;

create or replace function fn_update_resume_position(
  p_round_id uuid, p_segment_index integer, p_video_current_time_sec numeric
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_updated_id uuid;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  -- Deliberately narrow: only these two convenience columns are in this
  -- function's parameter list at all — status/transcript_id/provenance/
  -- accuracy/completed_at/required_sentence_count/round_number cannot be
  -- touched by any code path inside this function, not merely unchecked.
  update learning_sessions
  set current_segment_index = p_segment_index, video_current_time = p_video_current_time_sec, updated_at = now()
  where id = p_round_id and user_id = v_user_id
  returning id into v_updated_id;
  if v_updated_id is null then raise exception 'round_not_found'; end if;
  return jsonb_build_object('roundId', v_updated_id);
end;
$$;

create or replace function fn_restart_round(p_youtube_video_id text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_transcript_id uuid;
  v_required integer;
  v_round_number integer;
  v_new_round_id uuid;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || p_youtube_video_id));

  update learning_sessions set status = 'abandoned', updated_at = now()
  where user_id = v_user_id and youtube_video_id = p_youtube_video_id and status = 'active';

  select id into v_transcript_id from transcripts
    where youtube_video_id = p_youtube_video_id and language = 'en'
      and is_current = true and status = 'ready';
  if v_transcript_id is null then raise exception 'transcript_not_ready'; end if;

  v_required := fn_eligible_segment_count(v_transcript_id);
  select coalesce(max(round_number), 0) + 1 into v_round_number
    from learning_sessions where user_id = v_user_id and youtube_video_id = p_youtube_video_id;

  insert into learning_sessions (
    user_id, youtube_video_id, transcript_id, status, provenance, round_number, required_sentence_count
  ) values (
    v_user_id, p_youtube_video_id, v_transcript_id, 'active', 'current', v_round_number, v_required
  ) returning id into v_new_round_id;

  -- Force-close the current study-session boundary (§5.3 rule 4) —
  -- explicitly starting another round always ends the open session,
  -- regardless of the 30-minute inactivity window.
  update study_sessions set ended_at = now()
  where user_id = v_user_id and youtube_video_id = p_youtube_video_id and ended_at is null;

  return jsonb_build_object(
    'roundId', v_new_round_id, 'transcriptId', v_transcript_id,
    'roundNumber', v_round_number, 'requiredSentenceCount', v_required
  );
end;
$$;

-- =========================================================================
-- fn_get_or_create_study_session — user-actor, granted now
-- =========================================================================

create or replace function fn_get_or_create_study_session(
  p_youtube_video_id text,
  p_round_id uuid default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_session record;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;

  if p_round_id is not null then
    perform 1 from learning_sessions
      where id = p_round_id and user_id = v_user_id and youtube_video_id = p_youtube_video_id;
    if not found then raise exception 'round_mismatch'; end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || p_youtube_video_id));

  select * into v_session from study_sessions
    where user_id = v_user_id and youtube_video_id = p_youtube_video_id and ended_at is null
    order by last_activity_at desc limit 1
    for update;

  -- Reuse iff: an open session exists, it's within the inactivity window
  -- (§5.3 rule 3), AND its round assignment matches what's being asked for
  -- now (rule 4 — an explicit round change always force-closes, even
  -- within the window; `IS NOT DISTINCT FROM` so null=null, i.e. two
  -- round-less Listening callers, correctly counts as a match).
  if found and v_session.last_activity_at >= now() - interval '30 minutes'
     and v_session.round_id is not distinct from p_round_id then
    update study_sessions set last_activity_at = now() where id = v_session.id;
    return jsonb_build_object('studySessionId', v_session.id, 'roundId', v_session.round_id, 'created', false);
  end if;

  if found then
    update study_sessions set ended_at = now() where id = v_session.id;
  end if;

  insert into study_sessions (user_id, round_id, youtube_video_id)
    values (v_user_id, p_round_id, p_youtube_video_id)
    returning * into v_session;

  return jsonb_build_object('studySessionId', v_session.id, 'roundId', v_session.round_id, 'created', true);
end;
$$;

-- =========================================================================
-- fn_flush_study_activity — user-actor, granted now
-- =========================================================================

create or replace function fn_flush_study_activity(
  p_kind text,
  p_study_session_id uuid,
  p_flush_batch_id uuid,
  p_youtube_video_id text,
  p_intervals jsonb default '[]'::jsonb,
  p_transcript_id uuid default null,
  p_current_position_sec numeric default null,
  p_client_timezone text default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_session record;
  v_elem jsonb;
  v_count integer := 0;
  v_fingerprint text;
  v_existing_fp text;
  v_raw_observed_delta numeric := 0;
  v_covered_sec_before numeric := 0;
  v_covered_sec_after numeric := 0;
  v_existing_intervals jsonb;
  v_merged_intervals jsonb;
  v_valid_union jsonb;
  v_transcript_covered_sec numeric := 0;
  v_coverage_ratio numeric := 0;
  v_listened_through boolean := false;
  v_row_existed boolean;
  v_null_row_intervals jsonb;
  v_carried jsonb;
  v_final_intervals jsonb;
  v_has_history boolean;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_kind not in ('listening', 'activity') then raise exception 'invalid_flush_kind'; end if;

  -- Relationship validation (§9.7): owns the session AND it's for the
  -- claimed video — checking user_id alone would accept a session that
  -- happens to belong to the caller but a DIFFERENT video.
  select id, user_id, round_id into v_session
    from study_sessions
    where id = p_study_session_id and user_id = v_user_id and youtube_video_id = p_youtube_video_id
    for update;
  if not found then raise exception 'study_session_mismatch'; end if;

  if p_kind = 'listening' and p_transcript_id is not null then
    perform 1 from transcripts where id = p_transcript_id and youtube_video_id = p_youtube_video_id and status = 'ready';
    if not found then raise exception 'transcript_not_found_for_video'; end if;
  end if;

  -- Validate the raw interval payload BEFORE merging anything — finite,
  -- nonnegative, correctly ordered, and size-bounded (matches the
  -- MAX_PENDING_BUFFER_SEC-scale buffers this endpoint is meant for, not a
  -- full-session replay).
  if p_intervals is not null and jsonb_typeof(p_intervals) = 'array' then
    if jsonb_array_length(p_intervals) > 1000 then
      raise exception 'invalid_interval_payload';
    end if;
    for v_elem in select * from jsonb_array_elements(p_intervals) loop
      v_count := v_count + 1;
      if (v_elem->>'start') is null or (v_elem->>'end') is null then
        raise exception 'invalid_interval_payload';
      end if;
      if (v_elem->>'start')::numeric < 0 or (v_elem->>'end')::numeric <= (v_elem->>'start')::numeric
         or (v_elem->>'end')::numeric > 1e7 then
        raise exception 'invalid_interval_payload';
      end if;
    end loop;
  elsif p_intervals is not null and jsonb_typeof(p_intervals) <> 'array' then
    raise exception 'invalid_interval_payload';
  end if;

  -- Deterministic fingerprint of the semantic request — every field that
  -- affects the result, not only intervals (kind, target identities,
  -- revision, intervals, resume position, timezone). Distinguishes a
  -- genuine retry (same batch id, equivalent payload) from a reused batch
  -- id with different content (rejected, §6.3b/R27).
  v_fingerprint := md5(
    p_kind || '|' || p_study_session_id::text || '|' || p_youtube_video_id || '|' ||
    coalesce(p_transcript_id::text, '') || '|' || coalesce(p_intervals::text, '[]') || '|' ||
    coalesce(p_current_position_sec::text, '') || '|' || coalesce(p_client_timezone, '')
  );

  select payload_fingerprint into v_existing_fp
    from activity_flush_log
    where study_session_id = p_study_session_id and flush_batch_id = p_flush_batch_id;

  if found and v_existing_fp is distinct from v_fingerprint then
    raise exception 'flush_batch_id_reused_with_different_payload';
  elsif found then
    -- Genuine retry: pure no-op, reflecting current state.
    if p_kind = 'listening' and p_transcript_id is not null then
      select covered_sec, coverage_ratio, listened_through, last_position_sec
        into v_covered_sec_after, v_coverage_ratio, v_listened_through, v_covered_sec_before
        from listening_progress
        where user_id = v_user_id and youtube_video_id = p_youtube_video_id and transcript_id = p_transcript_id;
      v_has_history := exists(select 1 from listening_progress where user_id = v_user_id and youtube_video_id = p_youtube_video_id);
      return jsonb_build_object(
        'processed', false, 'coverageRatio', coalesce(v_coverage_ratio, 0),
        'listenedThrough', coalesce(v_listened_through, false), 'coveredSec', coalesce(v_covered_sec_after, 0),
        'lastPositionSec', coalesce(v_covered_sec_before, 0), 'hasHistory', coalesce(v_has_history, false)
      );
    end if;
    return jsonb_build_object('processed', false);
  end if;

  -- Not seen before: record the dedup marker AND apply the update, in the
  -- same transaction — a crash/error after this point rolls back the
  -- marker along with everything else (no marker-with-no-progress state).
  insert into activity_flush_log (study_session_id, flush_batch_id, kind, payload_fingerprint)
    values (p_study_session_id, p_flush_batch_id, p_kind, v_fingerprint);

  if p_kind = 'activity' then
    update study_sessions
    set activity_intervals = fn_merge_intervals(coalesce(activity_intervals, '[]'::jsonb) || coalesce(p_intervals, '[]'::jsonb)),
        last_activity_at = now()
    where id = p_study_session_id;
    return jsonb_build_object('processed', true);
  end if;

  -- kind = 'listening'. Shared-row race fix: EVERY listening flush always
  -- takes the null-transcript advisory lock FIRST, then (when
  -- transcript-scoped) the specific-transcript lock — one consistent
  -- order across every code path that could touch either row, which is
  -- what makes the null-row transition below concurrency-safe against a
  -- second tab flushing directly against the null row at the same moment,
  -- not just against another flush of the SAME transcript_id. This closes
  -- the exact gap flagged in the Phase 2 task: locking only study_sessions
  -- does not serialize two different sessions updating the same
  -- listening_progress row, and a locked UPSERT alone does not repair a
  -- covered_sec_before value already read outside the lock — the entire
  -- read -> merge -> delta -> write sequence below runs while holding
  -- this lock, not just the final write.
  perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || p_youtube_video_id || '::null'));
  if p_transcript_id is not null then
    perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || p_youtube_video_id || '::' || p_transcript_id::text));
  end if;

  v_raw_observed_delta := coalesce((
    select sum((elem->>'end')::numeric - (elem->>'start')::numeric) from jsonb_array_elements(coalesce(p_intervals, '[]'::jsonb)) as elem
  ), 0);

  if p_transcript_id is not null then
    select true, covered_sec, covered_intervals into v_row_existed, v_covered_sec_before, v_existing_intervals
      from listening_progress
      where user_id = v_user_id and youtube_video_id = p_youtube_video_id and transcript_id = p_transcript_id;
    v_row_existed := coalesce(v_row_existed, false);
    v_covered_sec_before := coalesce(v_covered_sec_before, 0);
    v_existing_intervals := coalesce(v_existing_intervals, '[]'::jsonb);

    v_merged_intervals := fn_merge_intervals(v_existing_intervals || coalesce(p_intervals, '[]'::jsonb));
    v_valid_union := fn_transcript_valid_union(p_transcript_id);
    v_transcript_covered_sec := fn_intervals_union_length(v_valid_union);
    v_covered_sec_after := fn_intervals_union_length(fn_intervals_intersect(v_merged_intervals, v_valid_union));
    v_coverage_ratio := case when v_transcript_covered_sec > 0 then least(1, v_covered_sec_after / v_transcript_covered_sec) else 0 end;
    v_listened_through := v_coverage_ratio >= 0.90;

    insert into listening_progress (
      user_id, youtube_video_id, transcript_id, covered_intervals, covered_sec,
      transcript_covered_sec, coverage_ratio, listened_through, listened_through_at,
      last_position_sec, last_synced_at
    ) values (
      v_user_id, p_youtube_video_id, p_transcript_id, v_merged_intervals, v_covered_sec_after,
      v_transcript_covered_sec, v_coverage_ratio, v_listened_through,
      case when v_listened_through then now() else null end,
      coalesce(p_current_position_sec, 0), now()
    )
    on conflict (user_id, youtube_video_id, transcript_id) where transcript_id is not null
    do update set
      covered_intervals = v_merged_intervals,
      covered_sec = v_covered_sec_after,
      transcript_covered_sec = v_transcript_covered_sec,
      coverage_ratio = v_coverage_ratio,
      listened_through = v_listened_through,
      listened_through_at = case when v_listened_through then coalesce(listening_progress.listened_through_at, now()) else null end,
      last_position_sec = coalesce(p_current_position_sec, listening_progress.last_position_sec),
      last_synced_at = now();

    -- One-time null-transcript carry-forward transition (§8.8 state 3) —
    -- only when this transcript-scoped row did NOT already exist, so a
    -- later revision (B, C, ...) never re-carries-forward from an
    -- already-superseded null row.
    if not v_row_existed then
      select covered_intervals into v_null_row_intervals
        from listening_progress
        where user_id = v_user_id and youtube_video_id = p_youtube_video_id
          and transcript_id is null and superseded_at is null
        for update;
      if found then
        v_carried := fn_intervals_intersect(coalesce(v_null_row_intervals, '[]'::jsonb), v_valid_union);
        if jsonb_array_length(v_carried) > 0 then
          v_final_intervals := fn_merge_intervals(v_merged_intervals || v_carried);
          v_covered_sec_after := fn_intervals_union_length(fn_intervals_intersect(v_final_intervals, v_valid_union));
          v_coverage_ratio := case when v_transcript_covered_sec > 0 then least(1, v_covered_sec_after / v_transcript_covered_sec) else 0 end;
          v_listened_through := v_coverage_ratio >= 0.90;
          update listening_progress
          set covered_intervals = v_final_intervals, covered_sec = v_covered_sec_after,
              coverage_ratio = v_coverage_ratio, listened_through = v_listened_through,
              listened_through_at = case when v_listened_through then coalesce(listened_through_at, now()) else null end
          where user_id = v_user_id and youtube_video_id = p_youtube_video_id and transcript_id = p_transcript_id;
        end if;
        update listening_progress set superseded_at = now()
          where user_id = v_user_id and youtube_video_id = p_youtube_video_id
            and transcript_id is null and superseded_at is null;
      end if;
    end if;
  else
    -- transcript_id is null (§8.8 state 2): raw observed intervals only;
    -- coverage_ratio/transcript_covered_sec stay 0/unset — no valid union
    -- exists yet to intersect against.
    select covered_intervals into v_existing_intervals
      from listening_progress
      where user_id = v_user_id and youtube_video_id = p_youtube_video_id and transcript_id is null;
    v_existing_intervals := coalesce(v_existing_intervals, '[]'::jsonb);
    v_merged_intervals := fn_merge_intervals(v_existing_intervals || coalesce(p_intervals, '[]'::jsonb));
    v_covered_sec_before := 0;
    v_covered_sec_after := 0;

    insert into listening_progress (user_id, youtube_video_id, transcript_id, covered_intervals, last_position_sec, last_synced_at)
      values (v_user_id, p_youtube_video_id, null, v_merged_intervals, coalesce(p_current_position_sec, 0), now())
      on conflict (user_id, youtube_video_id) where transcript_id is null
      do update set covered_intervals = v_merged_intervals,
                    last_position_sec = coalesce(p_current_position_sec, listening_progress.last_position_sec),
                    last_synced_at = now();
    v_coverage_ratio := 0;
    v_listened_through := false;
  end if;

  -- Session-scoped Listening counters (§5.3) — live on study_sessions, not
  -- listening_progress. Still holding step 1's row lock on study_sessions.
  update study_sessions
  set listening_observed_sec = listening_observed_sec + v_raw_observed_delta,
      listening_newly_covered_sec = listening_newly_covered_sec + (v_covered_sec_after - v_covered_sec_before),
      last_activity_at = now()
  where id = p_study_session_id;

  v_has_history := exists(select 1 from listening_progress where user_id = v_user_id and youtube_video_id = p_youtube_video_id);

  return jsonb_build_object(
    'processed', true, 'coverageRatio', v_coverage_ratio, 'listenedThrough', v_listened_through,
    'coveredSec', v_covered_sec_after, 'lastPositionSec', coalesce(p_current_position_sec, 0),
    'hasHistory', v_has_history
  );
end;
$$;

-- =========================================================================
-- fn_persist_azure_result / fn_persist_word_match_result — backend-only,
-- granted to service_role now
-- =========================================================================

create or replace function fn_persist_azure_result(
  p_attempt_id uuid,
  p_seq integer,
  p_status text,
  p_accuracy_score numeric default null,
  p_fluency_score numeric default null,
  p_completeness_score numeric default null,
  p_prosody_score numeric default null,
  p_pronunciation_score numeric default null,
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
  v_row record;
begin
  if p_status not in ('completed', 'failed') then raise exception 'invalid_azure_status'; end if;
  if p_status = 'completed' and (
       p_accuracy_score is null or p_fluency_score is null or
       p_completeness_score is null or p_pronunciation_score is null
     ) then
    raise exception 'incomplete_azure_scores';
  end if;

  -- WHERE id AND seq -- a stale response (an older request whose seq no
  -- longer matches the row's current value, because a newer Evaluate
  -- click already superseded it) matches zero rows and is silently
  -- discarded, never overwriting a newer result. Only azure_*/
  -- engine_version/updated_at are ever touched — ownership, round,
  -- segment, and practice-credit identity columns are not in this
  -- function's UPDATE at all.
  update shadowing_attempts
  set azure_eval_status = p_status,
      azure_accuracy_score = case when p_status = 'completed' then p_accuracy_score else null end,
      azure_fluency_score = case when p_status = 'completed' then p_fluency_score else null end,
      azure_completeness_score = case when p_status = 'completed' then p_completeness_score else null end,
      azure_prosody_score = case when p_status = 'completed' then p_prosody_score else null end,
      azure_pronunciation_score = case when p_status = 'completed' then p_pronunciation_score else null end,
      azure_error_reason = case when p_status = 'failed' then p_error_reason else null end,
      engine_version = coalesce(p_engine_version, engine_version),
      updated_at = now()
  where id = p_attempt_id and azure_eval_request_seq = p_seq
  returning * into v_row;

  if not found then
    return jsonb_build_object('applied', false);
  end if;
  return jsonb_build_object('applied', true, 'attemptId', v_row.id, 'azureEvalStatus', v_row.azure_eval_status);
end;
$$;

create or replace function fn_persist_word_match_result(
  p_attempt_id uuid,
  p_seq integer,
  p_status text,
  p_accuracy numeric default null,
  p_completeness numeric default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_row record;
begin
  if p_status not in ('completed', 'failed', 'unsupported') then raise exception 'invalid_word_match_status'; end if;

  -- word_match_request_seq (migration 034) -- independent from
  -- azure_eval_request_seq, so a stale Word Match response is never
  -- confused with an Azure request's own freshness.
  update shadowing_attempts
  set word_match_status = p_status,
      word_match_accuracy = case when p_status = 'completed' then p_accuracy else null end,
      word_match_completeness = case when p_status = 'completed' then p_completeness else null end,
      updated_at = now()
  where id = p_attempt_id and word_match_request_seq = p_seq
  returning * into v_row;

  if not found then
    return jsonb_build_object('applied', false);
  end if;
  return jsonb_build_object('applied', true, 'attemptId', v_row.id, 'wordMatchStatus', v_row.word_match_status);
end;
$$;

-- =========================================================================
-- Temporary legacy bridges — fn_legacy_save_progress, fn_legacy_restart_round,
-- fn_legacy_record_dictation_attempt. Each mirrors TODAY's actual route
-- logic exactly (same permissiveness, same trust level — deliberately NOT
-- improved beyond the write-gate check and, for save-progress, the
-- transcript-pin validation on the race-winner path the Phase 2 task
-- explicitly asked to add), so moving the write behind the gate changes
-- nothing else observable. All three are dropped once Phase 3's real
-- cutover lands.
-- =========================================================================

create or replace function fn_legacy_save_progress(
  p_session_id uuid default null,
  p_youtube_video_id text default null,
  p_transcript_id uuid default null,
  p_current_segment_index integer default null,
  p_video_current_time_sec numeric default 0,
  p_accuracy numeric default null,
  p_total_attempts integer default null,
  p_status text default 'active'
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing record;
  v_current_transcript_id uuid;
  v_new_id uuid;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_youtube_video_id is null then raise exception 'youtube_video_id_required'; end if;
  perform fn_check_write_gate();

  if p_session_id is not null then
    select id, transcript_id into v_existing
      from learning_sessions where id = p_session_id and user_id = v_user_id
      for update;
    if not found then raise exception 'session_not_found'; end if;

    if p_transcript_id is not null and v_existing.transcript_id is not null
       and p_transcript_id is distinct from v_existing.transcript_id then
      raise exception 'stale_transcript_revision';
    end if;

    -- transcript_id is deliberately never in this UPDATE — a round pins
    -- its revision at creation and never repins it from an ordinary
    -- progress save (Phase 0).
    update learning_sessions
    set current_segment_index = p_current_segment_index, video_current_time = p_video_current_time_sec,
        accuracy = p_accuracy, total_attempts = p_total_attempts, status = p_status, updated_at = now()
    where id = p_session_id and user_id = v_user_id;

    return jsonb_build_object('sessionId', p_session_id, 'status', p_status);
  end if;

  -- No sessionId: reuse-or-create, serialized by the SAME advisory lock
  -- ordering as fn_create_or_get_active_round/fn_restart_round — two
  -- concurrent first-saves for the SAME (user, video) now resolve
  -- deterministically instead of racing a raw INSERT.
  perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || p_youtube_video_id));

  select id, transcript_id into v_existing
    from learning_sessions
    where user_id = v_user_id and youtube_video_id = p_youtube_video_id and status = 'active'
    order by updated_at desc limit 1
    for update;

  if found then
    -- Concurrent-first-save race-winner reuse MUST validate the winner's
    -- transcript pin against this request (Phase 2 task §5) — never
    -- silently attach a revision-B request to a revision-A round.
    if p_transcript_id is not null and v_existing.transcript_id is not null
       and p_transcript_id is distinct from v_existing.transcript_id then
      raise exception 'stale_transcript_revision';
    end if;
    update learning_sessions
    set current_segment_index = p_current_segment_index, video_current_time = p_video_current_time_sec,
        accuracy = p_accuracy, total_attempts = p_total_attempts, status = p_status, updated_at = now()
    where id = v_existing.id and user_id = v_user_id;
    return jsonb_build_object('sessionId', v_existing.id, 'status', p_status);
  end if;

  select id into v_current_transcript_id from transcripts
    where youtube_video_id = p_youtube_video_id and language = 'en' and is_current = true;
  if v_current_transcript_id is null then raise exception 'transcript_not_ready'; end if;
  if p_transcript_id is not null and p_transcript_id is distinct from v_current_transcript_id then
    raise exception 'stale_transcript_revision';
  end if;

  begin
    insert into learning_sessions (
      user_id, youtube_video_id, transcript_id, current_segment_index,
      video_current_time, accuracy, total_attempts, status
    ) values (
      v_user_id, p_youtube_video_id, v_current_transcript_id, p_current_segment_index,
      p_video_current_time_sec, p_accuracy, p_total_attempts, p_status
    )
    returning id into v_new_id;
  exception when unique_violation then
    -- Defense-in-depth only — the advisory lock above already serializes
    -- every caller of THIS function for the same (user, video), so this
    -- branch is unreachable via this function alone; kept in case a
    -- residual direct writer exists during rollout. Resolves exactly like
    -- the ordinary reuse branch above, including the SAME transcript-pin
    -- validation.
    select id, transcript_id into v_existing
      from learning_sessions
      where user_id = v_user_id and youtube_video_id = p_youtube_video_id and status = 'active'
      order by updated_at desc limit 1;
    if not found then raise exception 'session_creation_conflict_unresolved'; end if;
    if p_transcript_id is not null and v_existing.transcript_id is not null
       and p_transcript_id is distinct from v_existing.transcript_id then
      raise exception 'stale_transcript_revision';
    end if;
    return jsonb_build_object('sessionId', v_existing.id, 'status', 'active');
  end;

  return jsonb_build_object('sessionId', v_new_id, 'status', p_status);
end;
$$;

create or replace function fn_legacy_restart_round(p_youtube_video_id text, p_session_id uuid default null)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  perform fn_check_write_gate();

  -- Mirrors session/restart/route.ts exactly: abandon the active round(s)
  -- for this (user, video) [optionally scoped to one sessionId]. Does NOT
  -- create a new round — today's route doesn't either; the next
  -- save-progress call creates one, unchanged by this migration.
  update learning_sessions
  set status = 'abandoned', updated_at = now()
  where user_id = v_user_id and youtube_video_id = p_youtube_video_id and status = 'active'
    and (p_session_id is null or id = p_session_id);

  return jsonb_build_object('status', 'ok');
end;
$$;

create or replace function fn_legacy_record_dictation_attempt(
  p_session_id uuid,
  p_segment_index integer,
  p_expected_text text,
  p_user_text text,
  p_normalized_expected_text text,
  p_normalized_user_text text,
  p_is_correct boolean,
  p_error_type text default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_new_id uuid;
begin
  -- No auth.uid() derivation — called via the SERVICE-ROLE client (see
  -- this migration's header note). session_id is a trusted, already-
  -- verified parameter: the ROUTE verifies ownership beforehand using the
  -- caller's OWN RLS-respecting client (unchanged from today's actual
  -- dictation/check/route.ts), before ever reaching this call.
  perform fn_check_write_gate();

  insert into attempt_logs (
    session_id, segment_index, expected_text, user_text,
    normalized_expected_text, normalized_user_text, is_correct, error_type
  ) values (
    p_session_id, p_segment_index, p_expected_text, p_user_text,
    p_normalized_expected_text, p_normalized_user_text, p_is_correct, p_error_type
  )
  returning id into v_new_id;

  return jsonb_build_object('attemptId', v_new_id);
end;
$$;

-- =========================================================================
-- Grants (§9.9) — explicit, function-signature-scoped, in this same
-- migration transaction. anon named explicitly everywhere, not only
-- public/authenticated/service_role.
-- =========================================================================

-- Dormant authoritative round-lifecycle functions.
revoke execute on function fn_create_or_get_active_round(text) from public, anon, authenticated, service_role;
revoke execute on function fn_update_resume_position(uuid, integer, numeric) from public, anon, authenticated, service_role;
revoke execute on function fn_restart_round(text) from public, anon, authenticated, service_role;

-- User-actor functions available now.
revoke execute on function fn_get_or_create_study_session(text, uuid) from public, anon, authenticated;
grant execute on function fn_get_or_create_study_session(text, uuid) to authenticated;
revoke execute on function fn_flush_study_activity(text, uuid, uuid, text, jsonb, uuid, numeric, text) from public, anon, authenticated;
grant execute on function fn_flush_study_activity(text, uuid, uuid, text, jsonb, uuid, numeric, text) to authenticated;
revoke execute on function fn_legacy_save_progress(uuid, text, uuid, integer, numeric, numeric, integer, text) from public, anon, authenticated;
grant execute on function fn_legacy_save_progress(uuid, text, uuid, integer, numeric, numeric, integer, text) to authenticated;
revoke execute on function fn_legacy_restart_round(text, uuid) from public, anon, authenticated;
grant execute on function fn_legacy_restart_round(text, uuid) to authenticated;

-- Backend-only functions.
revoke execute on function fn_persist_azure_result(uuid, integer, text, numeric, numeric, numeric, numeric, numeric, text, text) from public, anon, authenticated;
grant execute on function fn_persist_azure_result(uuid, integer, text, numeric, numeric, numeric, numeric, numeric, text, text) to service_role;
revoke execute on function fn_persist_word_match_result(uuid, integer, text, numeric, numeric) from public, anon, authenticated;
grant execute on function fn_persist_word_match_result(uuid, integer, text, numeric, numeric) to service_role;
revoke execute on function fn_legacy_record_dictation_attempt(uuid, integer, text, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function fn_legacy_record_dictation_attempt(uuid, integer, text, text, text, text, boolean, text) to service_role;

-- Private helpers — never directly callable by any application role.
revoke execute on function fn_check_write_gate() from public, anon, authenticated, service_role;
revoke execute on function fn_eligible_segment_count(uuid) from public, anon, authenticated, service_role;
revoke execute on function fn_merge_intervals(jsonb) from public, anon, authenticated, service_role;
revoke execute on function fn_intervals_union_length(jsonb) from public, anon, authenticated, service_role;
revoke execute on function fn_intervals_intersect(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke execute on function fn_transcript_valid_union(uuid) from public, anon, authenticated, service_role;
