-- =====================================================
-- 039 — Phase 5: Listening coverage + activity pulses
--
-- Phase 5 wires the Listening player and the activity pulse to the study-
-- session functions of 035 (granted to authenticated since Phase 2, never
-- called by the app). Doing so for real exposed defects in 035's
-- fn_flush_study_activity and a gap no route-level code can close
-- atomically, so this migration adds:
--
--  1. fn_apply_study_flush (internal, no role may call it) — 035's flush
--     body with these corrections:
--       * kind = 'activity' intervals are WALL-CLOCK epoch seconds (§6.3b);
--         035 checked every interval against the media-timeline cap
--         (end <= 1e7) and so rejected every real pulse. Bounds per kind:
--         listening = media seconds [0, 1e7]; activity = epoch seconds not
--         older than a day, at most 10 minutes ahead of the server clock,
--         at most 900 s long. Non-numbers and reversed intervals are
--         refused for both kinds.
--       * a Listening flush records 'listening' in modes_used, and
--         listening_progress.updated_at is maintained.
--       * the response reports the checkpoint actually stored (035 echoed
--         the request's, or 0) and the revision's coverage denominator.
--       * p_touch_session = false applies the data without moving the
--         session's last_activity_at (late data, below).
--  2. fn_flush_study_activity — same signature and grants as 035/036, now a
--     thin wrapper over (1) for the caller's own session.
--  3. fn_sync_study_activity — the single entry point the Phase 5 routes
--     use. In ONE transaction, under the (user, video) advisory lock that
--     every round-lifecycle function takes:
--       a. REPLAY FIRST, no side effects: a flush_batch_id this user already
--          recorded is answered from the session it was recorded under
--          (processed = false; a different payload is refused). A retry can
--          therefore never escape deduplication by reaching another
--          session — after a Restart, a session rollover or any delay.
--       b. Otherwise the batch is attributed by the ROUND IT WAS OBSERVED
--          UNDER (captured by the client at observation time and
--          relationship-checked here), never by "whatever round is current
--          now":
--            - observed under the video's current round (or under no round
--              while none exists) and not older than the 30-minute
--              inactivity window: the ordinary session rule (035
--              fn_get_or_create_study_session: reuse, or close + open);
--            - LATE data — observed under a round that has since been
--              superseded (abandoned, or another round is now active; or
--              observed round-less while a round now exists), or older than
--              30 minutes — goes to the most recent session of THAT round
--              without reopening it, closing anything, or moving its
--              timestamps. If that round never had a session the batch is
--              refused (late_activity_without_session) rather than rerouted
--              to another round's session.
--     The superseded test mirrors 037's fn_attribute_study_session.
--  4. An index on activity_flush_log(flush_batch_id) for (3a).
--
-- Numbering: Phase 5 takes 039. The Script Versions deletion function the
-- plan had reserved as 039 (never created) takes the next free number when
-- Phase 9 is implemented — creating a LOWER number after a higher one is
-- applied would make `supabase db push` refuse without --include-all.
-- Compatible with the deployed app (it calls none of these); no table
-- definition, row or existing grant changes.
-- =====================================================

create index if not exists activity_flush_log_batch_idx on activity_flush_log(flush_batch_id);

create or replace function fn_apply_study_flush(
  p_user_id uuid,
  p_kind text,
  p_study_session_id uuid,
  p_flush_batch_id uuid,
  p_youtube_video_id text,
  p_intervals jsonb,
  p_transcript_id uuid,
  p_current_position_sec numeric,
  p_client_timezone text,
  p_touch_session boolean
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := p_user_id;
  v_session record;
  v_last_position numeric;
  v_elem jsonb;
  v_start numeric;
  v_end numeric;
  v_now_epoch numeric := extract(epoch from now());
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
  if p_flush_batch_id is null or p_youtube_video_id is null then raise exception 'invalid_interval_payload'; end if;
  if p_kind not in ('listening', 'activity') then raise exception 'invalid_flush_kind'; end if;

  -- Relationship validation (§9.7): owns the session AND it's for the
  -- claimed video.
  select id, user_id, round_id into v_session
    from study_sessions
    where id = p_study_session_id and user_id = v_user_id and youtube_video_id = p_youtube_video_id
    for update;
  if not found then raise exception 'study_session_mismatch'; end if;

  if p_kind = 'listening' and p_transcript_id is not null then
    perform 1 from transcripts where id = p_transcript_id and youtube_video_id = p_youtube_video_id and status = 'ready';
    if not found then raise exception 'transcript_not_found_for_video'; end if;
  end if;

  if p_client_timezone is not null and length(p_client_timezone) > 64 then
    raise exception 'invalid_interval_payload';
  end if;
  if p_current_position_sec is not null and (p_current_position_sec < 0 or p_current_position_sec > 1e7) then
    raise exception 'invalid_interval_payload';
  end if;

  -- Validate the raw interval payload BEFORE merging anything — finite,
  -- correctly ordered, size-bounded, and within the kind's own axis.
  if p_intervals is not null and jsonb_typeof(p_intervals) = 'array' then
    if jsonb_array_length(p_intervals) > 1000 then
      raise exception 'invalid_interval_payload';
    end if;
    for v_elem in select * from jsonb_array_elements(p_intervals) loop
      if jsonb_typeof(v_elem) <> 'object'
         or jsonb_typeof(v_elem->'start') is distinct from 'number'
         or jsonb_typeof(v_elem->'end') is distinct from 'number' then
        raise exception 'invalid_interval_payload';
      end if;
      v_start := (v_elem->>'start')::numeric;
      v_end := (v_elem->>'end')::numeric;
      if v_end <= v_start then raise exception 'invalid_interval_payload'; end if;
      if p_kind = 'listening' then
        -- media-timeline seconds
        if v_start < 0 or v_end > 1e7 then raise exception 'invalid_interval_payload'; end if;
      else
        -- wall-clock epoch seconds (§6.3b): not older than a day (the
        -- client queue is memory-only), at most 10 minutes ahead of the
        -- server clock (skew), and at most 900 s long.
        if v_start < v_now_epoch - 86400 or v_end > v_now_epoch + 600 or v_end - v_start > 900 then
          raise exception 'invalid_interval_payload';
        end if;
      end if;
    end loop;
  elsif p_intervals is not null and jsonb_typeof(p_intervals) <> 'array' then
    raise exception 'invalid_interval_payload';
  end if;

  -- Deterministic fingerprint of the semantic request (unchanged from 035).
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
      select covered_sec, coverage_ratio, listened_through, last_position_sec, transcript_covered_sec
        into v_covered_sec_after, v_coverage_ratio, v_listened_through, v_covered_sec_before, v_transcript_covered_sec
        from listening_progress
        where user_id = v_user_id and youtube_video_id = p_youtube_video_id and transcript_id = p_transcript_id;
      v_has_history := exists(select 1 from listening_progress where user_id = v_user_id and youtube_video_id = p_youtube_video_id);
      return jsonb_build_object(
        'processed', false, 'coverageRatio', coalesce(v_coverage_ratio, 0),
        'listenedThrough', coalesce(v_listened_through, false), 'coveredSec', coalesce(v_covered_sec_after, 0),
        'lastPositionSec', coalesce(v_covered_sec_before, 0), 'hasHistory', coalesce(v_has_history, false),
        'transcriptCoveredSec', v_transcript_covered_sec
      );
    end if;
    return jsonb_build_object('processed', false);
  end if;

  insert into activity_flush_log (study_session_id, flush_batch_id, kind, payload_fingerprint)
    values (p_study_session_id, p_flush_batch_id, p_kind, v_fingerprint);

  if p_kind = 'activity' then
    update study_sessions
    set activity_intervals = fn_merge_intervals(coalesce(activity_intervals, '[]'::jsonb) || coalesce(p_intervals, '[]'::jsonb)),
        last_activity_at = case when p_touch_session then now() else last_activity_at end
    where id = p_study_session_id;
    return jsonb_build_object('processed', true);
  end if;

  -- kind = 'listening' — same lock order as 035: the null-transcript lock
  -- first, then the specific revision's.
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
      last_position_sec, last_synced_at, updated_at
    ) values (
      v_user_id, p_youtube_video_id, p_transcript_id, v_merged_intervals, v_covered_sec_after,
      v_transcript_covered_sec, v_coverage_ratio, v_listened_through,
      case when v_listened_through then now() else null end,
      coalesce(p_current_position_sec, 0), now(), now()
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
      last_synced_at = now(),
      updated_at = now();

    -- One-time null-transcript carry-forward transition (§8.8 state 3).
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
              listened_through_at = case when v_listened_through then coalesce(listened_through_at, now()) else null end,
              updated_at = now()
          where user_id = v_user_id and youtube_video_id = p_youtube_video_id and transcript_id = p_transcript_id;
        end if;
        update listening_progress set superseded_at = now(), updated_at = now()
          where user_id = v_user_id and youtube_video_id = p_youtube_video_id
            and transcript_id is null and superseded_at is null;
      end if;
    end if;
  else
    -- No transcript yet (§8.8 state 2): raw observed intervals only.
    select covered_intervals into v_existing_intervals
      from listening_progress
      where user_id = v_user_id and youtube_video_id = p_youtube_video_id and transcript_id is null;
    v_existing_intervals := coalesce(v_existing_intervals, '[]'::jsonb);
    v_merged_intervals := fn_merge_intervals(v_existing_intervals || coalesce(p_intervals, '[]'::jsonb));
    v_covered_sec_before := 0;
    v_covered_sec_after := 0;

    insert into listening_progress (user_id, youtube_video_id, transcript_id, covered_intervals, last_position_sec, last_synced_at, updated_at)
      values (v_user_id, p_youtube_video_id, null, v_merged_intervals, coalesce(p_current_position_sec, 0), now(), now())
      on conflict (user_id, youtube_video_id) where transcript_id is null
      do update set covered_intervals = v_merged_intervals,
                    last_position_sec = coalesce(p_current_position_sec, listening_progress.last_position_sec),
                    last_synced_at = now(),
                    updated_at = now();
    v_coverage_ratio := 0;
    v_listened_through := false;
  end if;

  -- Session-scoped Listening counters (§5.3), plus the mode (§5.3 rule 2).
  update study_sessions
  set listening_observed_sec = listening_observed_sec + v_raw_observed_delta,
      listening_newly_covered_sec = listening_newly_covered_sec + (v_covered_sec_after - v_covered_sec_before),
      modes_used = case when modes_used ? 'listening' then modes_used else modes_used || '"listening"'::jsonb end,
      last_activity_at = case when p_touch_session then now() else last_activity_at end
  where id = p_study_session_id;

  -- The checkpoint actually stored (a batch without one keeps the previous).
  select last_position_sec into v_last_position
    from listening_progress
    where user_id = v_user_id and youtube_video_id = p_youtube_video_id and transcript_id is not distinct from p_transcript_id
      and (p_transcript_id is not null or superseded_at is null);

  v_has_history := exists(select 1 from listening_progress where user_id = v_user_id and youtube_video_id = p_youtube_video_id);

  return jsonb_build_object(
    'processed', true, 'coverageRatio', v_coverage_ratio, 'listenedThrough', v_listened_through,
    'coveredSec', v_covered_sec_after, 'lastPositionSec', coalesce(v_last_position, 0),
    'hasHistory', v_has_history,
    'transcriptCoveredSec', case when p_transcript_id is not null then v_transcript_covered_sec end
  );
end;
$$;

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
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  return fn_apply_study_flush(auth.uid(), p_kind, p_study_session_id, p_flush_batch_id, p_youtube_video_id,
                              p_intervals, p_transcript_id, p_current_position_sec, p_client_timezone, true);
end;
$$;

create or replace function fn_sync_study_activity(
  p_kind text,
  p_flush_batch_id uuid,
  p_youtube_video_id text,
  p_round_id uuid default null,
  p_intervals jsonb default '[]'::jsonb,
  p_transcript_id uuid default null,
  p_current_position_sec numeric default null,
  p_client_timezone text default null,
  p_observed_age_sec numeric default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_active_round uuid;
  v_round_status text;
  v_late boolean;
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_flush_batch_id is null or p_youtube_video_id is null then raise exception 'invalid_interval_payload'; end if;
  if p_observed_age_sec is not null and (p_observed_age_sec < 0 or p_observed_age_sec > 7 * 86400) then
    raise exception 'invalid_interval_payload';
  end if;

  -- Same lock (and order) as every round-lifecycle / session function.
  perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || p_youtube_video_id));

  -- (a) Replay: answered from the session that recorded it. Nothing else is
  --     read or changed before this point.
  select l.study_session_id into v_session_id
    from activity_flush_log l join study_sessions s on s.id = l.study_session_id
    where l.flush_batch_id = p_flush_batch_id and s.user_id = v_user_id
    order by l.processed_at limit 1;
  if found then
    v_result := fn_apply_study_flush(v_user_id, p_kind, v_session_id, p_flush_batch_id, p_youtube_video_id,
                                     p_intervals, p_transcript_id, p_current_position_sec, p_client_timezone, false);
    return v_result || jsonb_build_object('studySessionId', v_session_id, 'attribution', 'replay');
  end if;

  -- (b) Attribution by the observed round.
  if p_round_id is not null then
    select status into v_round_status from learning_sessions
      where id = p_round_id and user_id = v_user_id and youtube_video_id = p_youtube_video_id;
    if not found then raise exception 'round_mismatch'; end if;
  end if;
  select id into v_active_round from learning_sessions
    where user_id = v_user_id and youtube_video_id = p_youtube_video_id and status = 'active'
    order by updated_at desc limit 1;

  v_late := coalesce(p_observed_age_sec, 0) > 1800
    or case when p_round_id is null then v_active_round is not null
            else v_round_status = 'abandoned' or (v_active_round is not null and v_active_round <> p_round_id) end;

  if not v_late then
    v_session_id := (fn_get_or_create_study_session(p_youtube_video_id, p_round_id)->>'studySessionId')::uuid;
  else
    select id into v_session_id from study_sessions
      where user_id = v_user_id and youtube_video_id = p_youtube_video_id and round_id is not distinct from p_round_id
      order by last_activity_at desc, started_at desc limit 1;
    if not found then raise exception 'late_activity_without_session'; end if;
  end if;

  v_result := fn_apply_study_flush(v_user_id, p_kind, v_session_id, p_flush_batch_id, p_youtube_video_id,
                                   p_intervals, p_transcript_id, p_current_position_sec, p_client_timezone, not v_late);
  return v_result || jsonb_build_object('studySessionId', v_session_id, 'attribution', case when v_late then 'late' else 'current' end);
end;
$$;

-- Privileges (exact signatures). The internal function is callable by no
-- application role; the two entry points are for authenticated only (036's
-- state for fn_flush_study_activity, unchanged).
revoke execute on function fn_apply_study_flush(uuid, text, uuid, uuid, text, jsonb, uuid, numeric, text, boolean) from public, anon, authenticated, service_role;
revoke execute on function fn_flush_study_activity(text, uuid, uuid, text, jsonb, uuid, numeric, text) from public, anon, service_role;
grant execute on function fn_flush_study_activity(text, uuid, uuid, text, jsonb, uuid, numeric, text) to authenticated;
revoke execute on function fn_sync_study_activity(text, uuid, text, uuid, jsonb, uuid, numeric, text, numeric) from public, anon, service_role;
grant execute on function fn_sync_study_activity(text, uuid, text, uuid, jsonb, uuid, numeric, text, numeric) to authenticated;
