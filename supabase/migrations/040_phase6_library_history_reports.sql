-- =====================================================
-- Phase 6 — Library, Dashboard, History and whole-round reports
--
-- Read models over the authoritative data written by Phases 3–5, plus the
-- Library membership writes. Nothing here rewrites historical rows.
--
--   user_video_removals            — removal markers for "Remove from
--                                     Library" (+ the removed video's last
--                                     mode); only an explicit Add clears one
--   fn_library_add_video           — Add Video (explicit) / first round and
--                                     Listening (implicit, never over a removal)
--   fn_library_remove_video        — removes ONLY the caller's membership
--   fn_set_video_last_mode         — mode switch (convenience only; never
--                                     restores a removed video)
--   activity_flush_log + 3 columns — the activity batch's captured IANA
--                                     timezone and the LOCAL dates it covers
--   fn_apply_study_flush           — 039's body, now also storing those
--   fn_video_library               — paginated, one card per video
--   fn_dashboard_summary           — account-wide metrics (§6.8)
--   fn_activity_days               — activity days, all three modes (local
--                                     dates; documented UTC fallback)
--   fn_history_sessions            — study-session History (keyset pages)
--   fn_round_report                — whole-round report (one round)
--   fn_my_round_progress           — the caller's round progress (resume)
--   fn_phase6_reconcile_membership — owner-only, one-time and re-runnable
--
-- Reads are SECURITY DEFINER with every row scoped to auth.uid() (the
-- 037/038 convention) and a pinned search_path; they return bounded,
-- paginated results. Internal helpers that take a user id are callable by
-- no application role.
--
-- See .claude/video-learning-management-plan.md Phase 6 and
-- supabase/PHASE6_RUNBOOK.md.
-- =====================================================

-- -------------------------------------------------------------------------
-- 1. Membership tombstones
-- -------------------------------------------------------------------------

create table if not exists user_video_removals (
  user_id uuid not null references users(id) on delete cascade,
  youtube_video_id text not null,
  removed_at timestamptz not null default now(),
  -- The video's last mode while it is removed (moved here from user_videos
  -- on removal, updated by mode switches, carried back by an explicit Add).
  last_mode text null check (last_mode in ('dictation', 'listening', 'shadowing')),
  primary key (user_id, youtube_video_id)
);

comment on table user_video_removals is
  'Phase 6: a video the user deliberately removed from their Library. Written '
  'only by fn_library_remove_video, cleared only by an explicit Add '
  '(fn_library_add_video with p_explicit = true). Mode switches, practice, '
  'Listening, automatic first-use adds and fn_phase6_reconcile_membership '
  'all respect it. last_mode holds the video''s last mode while removed.';

alter table user_video_removals enable row level security;
drop policy if exists "user_video_removals_owner_select" on user_video_removals;
create policy "user_video_removals_owner_select" on user_video_removals
  for select using (auth.uid() = user_id);
revoke all on user_video_removals from public, anon, authenticated, service_role;
grant select on user_video_removals to authenticated;

create index if not exists study_sessions_user_started_idx on study_sessions(user_id, started_at desc, id desc);
create index if not exists attempt_logs_study_session_idx on attempt_logs(study_session_id) where study_session_id is not null;
create index if not exists shadowing_attempts_study_session_idx on shadowing_attempts(study_session_id) where study_session_id is not null;
create index if not exists learning_sessions_user_video_idx on learning_sessions(user_id, youtube_video_id);

-- -------------------------------------------------------------------------
-- 2. Membership writes
-- -------------------------------------------------------------------------

create or replace function fn_valid_video_id(p_youtube_video_id text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_youtube_video_id is not null and btrim(p_youtube_video_id) <> '' and length(p_youtube_video_id) <= 64;
$$;

-- Every membership writer takes this per-(user, video) lock first, so a
-- removal and a concurrent add / mode switch / automatic first-use add are
-- serialized: whichever commits second sees the other's result, and a
-- delayed automatic write can never undo a removal it raced with.
create or replace function fn_lock_library_entry(p_user_id uuid, p_youtube_video_id text)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$
  select pg_advisory_xact_lock(hashtext(p_user_id::text || '::library::' || p_youtube_video_id));
$$;

-- Adds the video to the caller's Library. Repeating it never duplicates the
-- card and never moves the original added_at; rounds and progress are not
-- touched.
--   p_explicit = true  (Add Video / "Add back to Library"): also clears a
--     removal. A removed video gets a NEW membership (added_at = now — the
--     re-add) carrying the last mode it had while removed; its rounds,
--     reports and Listening progress were never deleted, so they reappear.
--   p_explicit = false (automatic — a video's first round, Listening
--     activity): adds membership only if the user never removed the video,
--     so background or delayed activity can never undo a deliberate removal.
create or replace function fn_library_add_video(p_youtube_video_id text, p_explicit boolean default true)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_added_at timestamptz;
  v_created boolean;
  v_removed_mode text;
  v_was_removed boolean;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not fn_valid_video_id(p_youtube_video_id) or p_explicit is null then raise exception 'invalid_payload'; end if;
  perform fn_lock_library_entry(v_user, p_youtube_video_id);

  select last_mode, true into v_removed_mode, v_was_removed
    from user_video_removals where user_id = v_user and youtube_video_id = p_youtube_video_id;
  v_was_removed := coalesce(v_was_removed, false);

  if not p_explicit and v_was_removed then
    return jsonb_build_object('videoId', p_youtube_video_id, 'added', false, 'suppressedByRemoval', true);
  end if;

  insert into user_videos (user_id, youtube_video_id, last_mode)
    values (v_user, p_youtube_video_id, v_removed_mode)
    on conflict (user_id, youtube_video_id) do nothing
    returning added_at into v_added_at;
  v_created := v_added_at is not null;
  if not v_created then
    select added_at into v_added_at from user_videos where user_id = v_user and youtube_video_id = p_youtube_video_id;
  end if;
  if p_explicit and v_was_removed then
    delete from user_video_removals where user_id = v_user and youtube_video_id = p_youtube_video_id;
  end if;

  return jsonb_build_object('videoId', p_youtube_video_id, 'added', v_created, 'addedAt', v_added_at,
                            'restoredFromRemoval', p_explicit and v_was_removed);
end;
$$;

-- Removes ONLY the caller's membership row. Rounds, attempts, reports,
-- Listening progress, study sessions, transcripts and every other user's
-- data are untouched. The removal marker keeps every automatic writer and
-- the reconciliation from re-adding it, and keeps the video's last mode.
create or replace function fn_library_remove_video(p_youtube_video_id text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_mode text;
  v_removed boolean;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not fn_valid_video_id(p_youtube_video_id) then raise exception 'invalid_payload'; end if;
  perform fn_lock_library_entry(v_user, p_youtube_video_id);

  delete from user_videos where user_id = v_user and youtube_video_id = p_youtube_video_id
    returning last_mode into v_mode;
  v_removed := found;
  if v_removed then
    insert into user_video_removals (user_id, youtube_video_id, removed_at, last_mode)
      values (v_user, p_youtube_video_id, now(), v_mode)
      on conflict (user_id, youtube_video_id) do update
        set removed_at = excluded.removed_at, last_mode = coalesce(excluded.last_mode, user_video_removals.last_mode);
  end if;
  return jsonb_build_object('videoId', p_youtube_video_id, 'removed', v_removed);
end;
$$;

-- A mode switch on the practice page. Convenience only — never a source of
-- scores, completion, practice credit or activity time, and NEVER a request
-- to restore Library membership:
--   member            → user_videos.last_mode
--   removed           → user_video_removals.last_mode (the card stays
--                       removed; an explicit Add carries the mode back)
--   neither (a video opened by link that was never added or removed) → a
--                       membership is created, as an automatic add would.
create or replace function fn_set_video_last_mode(p_youtube_video_id text, p_mode text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_inserted boolean := false;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not fn_valid_video_id(p_youtube_video_id) or p_mode is null
     or p_mode not in ('dictation', 'listening', 'shadowing') then
    raise exception 'invalid_payload';
  end if;
  perform fn_lock_library_entry(v_user, p_youtube_video_id);

  update user_videos set last_mode = p_mode, updated_at = now()
   where user_id = v_user and youtube_video_id = p_youtube_video_id;
  if found then
    return jsonb_build_object('videoId', p_youtube_video_id, 'lastMode', p_mode, 'added', false, 'inLibrary', true);
  end if;

  update user_video_removals set last_mode = p_mode
   where user_id = v_user and youtube_video_id = p_youtube_video_id;
  if found then
    return jsonb_build_object('videoId', p_youtube_video_id, 'lastMode', p_mode, 'added', false, 'inLibrary', false);
  end if;

  insert into user_videos (user_id, youtube_video_id, last_mode)
    values (v_user, p_youtube_video_id, p_mode)
    on conflict (user_id, youtube_video_id) do update set last_mode = excluded.last_mode, updated_at = now()
    returning (xmax = 0) into v_inserted;
  return jsonb_build_object('videoId', p_youtube_video_id, 'lastMode', p_mode, 'added', v_inserted, 'inLibrary', true);
end;
$$;

-- The caller's last mode for a video: from the membership, else from the
-- removal marker (a removed video keeps its mode without a membership).
create or replace function fn_video_last_mode(p_youtube_video_id text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select last_mode from user_videos where user_id = auth.uid() and youtube_video_id = p_youtube_video_id),
    (select last_mode from user_video_removals where user_id = auth.uid() and youtube_video_id = p_youtube_video_id)
  );
$$;

-- -------------------------------------------------------------------------
-- 3. Internal aggregation helpers (no application role may call these —
--    they take a user id). Same rules as §6.6/§6.7 and fn_round_progress.
-- -------------------------------------------------------------------------

create or replace function fn_word_count(p_text text)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  -- Same tokenization as the client's splitSentenceIntoWords (whitespace).
  select case when p_text is null or btrim(p_text) = '' then 0
              else coalesce(array_length(regexp_split_to_array(btrim(p_text), '\s+'), 1), 0) end;
$$;

-- Dictation sentence accuracy: the LATEST valid answer per (round, sentence)
-- (created_at, then id). Only latest answers written by the verified
-- (Phase 3) writer are counted; latest answers carried over from the
-- unverified legacy history are reported separately, never blended.
create or replace function fn_dictation_accuracy_summary(p_user_id uuid, p_round_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with latest as (
    select distinct on (a.session_id, a.segment_index) a.is_correct, a.segment_identity_provenance
      from attempt_logs a
      join learning_sessions r on r.id = a.session_id
     where r.user_id = p_user_id and (p_round_id is null or r.id = p_round_id) and a.is_practice_valid
     order by a.session_id, a.segment_index, a.created_at desc, a.id desc
  )
  select jsonb_build_object(
    'correct', count(*) filter (where segment_identity_provenance = 'verified' and is_correct),
    'practiced', count(*) filter (where segment_identity_provenance = 'verified'),
    'excludedUnverified', count(*) filter (where segment_identity_provenance <> 'verified')
  )
  from latest;
$$;

-- Shadowing aggregates, never blended (§6.7): Azure only from saved
-- successful Azure results (no Word Match fallback), Word Match only from
-- saved Word Match results, each with its own evaluated-sentence count.
-- Latest successful result per (round, sentence) — chronological, never
-- "best". Accuracy/completeness/pronunciation are word-count weighted,
-- fluency/prosody duration weighted (videoPracticeSummary.ts). Missing
-- scores are excluded from an average, never counted as zero.
create or replace function fn_shadowing_summary(p_user_id uuid, p_round_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with mine as (
    select sa.* from shadowing_attempts sa
     where sa.user_id = p_user_id and (p_round_id is null or sa.round_id = p_round_id)
  ),
  az as (
    select distinct on (m.round_id, m.segment_index) m.*, fn_word_count(ts.text_raw) as words
      from mine m
      left join transcript_segments ts on ts.transcript_id = m.transcript_id and ts.segment_index = m.segment_index
     where m.azure_eval_status = 'completed'
     order by m.round_id, m.segment_index, m.created_at desc, m.id desc
  ),
  wm as (
    select distinct on (m.round_id, m.segment_index) m.*, fn_word_count(ts.text_raw) as words
      from mine m
      left join transcript_segments ts on ts.transcript_id = m.transcript_id and ts.segment_index = m.segment_index
     where m.word_match_status = 'completed'
     order by m.round_id, m.segment_index, m.created_at desc, m.id desc
  )
  select jsonb_build_object(
    'takes', (select count(*) from mine),
    'practicedSentences', (select count(*) from (select distinct round_id, segment_index from mine where is_practice_valid) p),
    'attemptedSentences', (select count(*) from (select distinct round_id, segment_index from mine) p),
    'azure', (
      select jsonb_build_object(
        'evaluatedSentences', count(*),
        'pronunciation', round(sum(azure_pronunciation_score * words) filter (where azure_pronunciation_score is not null)
                               / nullif(sum(words) filter (where azure_pronunciation_score is not null), 0), 1),
        'accuracy', round(sum(azure_accuracy_score * words) filter (where azure_accuracy_score is not null)
                          / nullif(sum(words) filter (where azure_accuracy_score is not null), 0), 1),
        'completeness', round(sum(azure_completeness_score * words) filter (where azure_completeness_score is not null)
                              / nullif(sum(words) filter (where azure_completeness_score is not null), 0), 1),
        'fluency', round(sum(azure_fluency_score * recording_duration_sec) filter (where azure_fluency_score is not null)
                         / nullif(sum(recording_duration_sec) filter (where azure_fluency_score is not null), 0), 1),
        'prosody', round(sum(azure_prosody_score * recording_duration_sec) filter (where azure_prosody_score is not null)
                         / nullif(sum(recording_duration_sec) filter (where azure_prosody_score is not null), 0), 1)
      ) from az),
    'wordMatch', (
      select jsonb_build_object(
        'evaluatedSentences', count(*),
        'accuracy', round(sum(word_match_accuracy * words) filter (where word_match_accuracy is not null)
                          / nullif(sum(words) filter (where word_match_accuracy is not null), 0), 1),
        'completeness', round(sum(word_match_completeness * words) filter (where word_match_completeness is not null)
                              / nullif(sum(words) filter (where word_match_completeness is not null), 0), 1)
      ) from wm)
  );
$$;

-- Engaged wall-clock time: the UNION of activity intervals across the given
-- study sessions, so overlapping time in two sessions (two tabs) counts once.
create or replace function fn_activity_union(p_user_id uuid, p_round_id uuid, p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'activeSec', round(fn_intervals_union_length(coalesce(jsonb_agg(e) filter (where e is not null), '[]'::jsonb)), 1),
    'trackedSince', to_timestamp(min((e->>'start')::float8)),
    'sessionCount', count(distinct s.id)
  )
  from study_sessions s
  left join lateral jsonb_array_elements(s.activity_intervals) e on true
  where s.user_id = p_user_id
    and (p_round_id is null or s.round_id = p_round_id)
    and (p_session_id is null or s.id = p_session_id);
$$;

revoke all on function fn_valid_video_id(text) from public, anon, authenticated, service_role;
revoke all on function fn_lock_library_entry(uuid, text) from public, anon, authenticated, service_role;
revoke all on function fn_word_count(text) from public, anon, authenticated, service_role;
revoke all on function fn_dictation_accuracy_summary(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function fn_shadowing_summary(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function fn_activity_union(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- 3b. Local-day attribution of activity (streaks)
-- -------------------------------------------------------------------------
--
-- 039 fingerprinted the batch's client timezone but stored nothing. Each
-- activity batch now keeps its timezone and the local dates it covers —
-- per batch, so a session that crosses midnight or receives delayed data
-- keeps every day it was active on (no session-wide date is overwritten).
-- Old rows keep NULL here: they predate attribution (see fn_activity_days).
alter table activity_flush_log add column if not exists client_timezone text null;
alter table activity_flush_log add column if not exists activity_dates date[] null;
alter table activity_flush_log add column if not exists day_basis text null;
alter table activity_flush_log drop constraint if exists activity_flush_log_day_basis_check;
alter table activity_flush_log add constraint activity_flush_log_day_basis_check
  check (day_basis is null or day_basis in ('local', 'utc_fallback'));

comment on column activity_flush_log.activity_dates is
  'Phase 6: local calendar dates covered by this activity batch''s wall-clock '
  'intervals, in client_timezone (day_basis = local) or in UTC when the batch '
  'carried no valid IANA timezone (day_basis = utc_fallback). NULL for '
  'Listening batches (media time) and for batches recorded before 040.';

-- A real IANA zone name known to this database. Two cheap checks (this runs
-- on every activity flush — pg_timezone_names reads every tz file, ~0.4 s):
--   1. the IANA SHAPE: Area/Location (letters, _, +, -), UTC, GMT or
--      Etc/GMT±N — which excludes POSIX specs ('UTC+7', 'EST5EDT'),
--      abbreviations ('PST') and 'localtime', all of which AT TIME ZONE
--      would otherwise accept as fixed or rule-less offsets;
--   2. PostgreSQL's tz database knows it (a cached lookup).
-- Calendar arithmetic is then done by the tz database, so DST and
-- non-24-hour days are handled.
create or replace function fn_valid_time_zone(p_time_zone text)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if p_time_zone is null or length(p_time_zone) > 64
     or not (p_time_zone ~ '^[A-Za-z_]+(/[A-Za-z_+-]+)+$'
             or p_time_zone in ('UTC', 'GMT')
             or p_time_zone ~ '^Etc/GMT[+-]([0-9]|1[0-4])$') then
    return false;
  end if;
  perform now() at time zone p_time_zone;
  return true;
exception when invalid_parameter_value then
  return false;
end;
$$;

-- Every local date a set of wall-clock intervals (epoch seconds, half-open
-- [start, end)) actually touches. Only active intervals are dated, so idle
-- time — including idle time across midnight — never creates a date; an
-- interval that really runs across local midnight counts on both dates.
create or replace function fn_local_activity_dates(p_intervals jsonb, p_time_zone text)
returns date[]
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct d order by d), '{}'::date[])
    from (
      select gs::date as d
        from jsonb_array_elements(coalesce(p_intervals, '[]'::jsonb)) e
        cross join lateral generate_series(
          (to_timestamp((e->>'start')::float8) at time zone p_time_zone)::date,
          (to_timestamp(greatest((e->>'start')::float8, (e->>'end')::float8 - 0.001)) at time zone p_time_zone)::date,
          interval '1 day') gs
    ) dates;
$$;

revoke all on function fn_valid_time_zone(text) from public, anon, authenticated, service_role;
revoke all on function fn_local_activity_dates(jsonb, text) from public, anon, authenticated, service_role;

-- 039's fn_apply_study_flush, unchanged except for the day attribution in
-- the activity_flush_log insert. Same signature, still callable by no
-- application role; fn_flush_study_activity and fn_sync_study_activity
-- (039) call it, so replay-first dedup, late attribution and Listening
-- checkpoints behave exactly as before.
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
  v_tz_valid boolean;
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

  -- Phase 6: an ACTIVITY batch records the local calendar dates its
  -- wall-clock intervals cover, in the IANA timezone the client captured
  -- when it sealed the batch (part of the fingerprint above, so a retry can
  -- never re-date it). Dates come from when the activity happened, never
  -- from when the batch arrived. A missing/unknown timezone does not reject
  -- the batch: its dates are UTC dates, marked utc_fallback.
  v_tz_valid := p_kind = 'activity' and fn_valid_time_zone(p_client_timezone);
  insert into activity_flush_log (study_session_id, flush_batch_id, kind, payload_fingerprint,
                                  client_timezone, activity_dates, day_basis)
    values (p_study_session_id, p_flush_batch_id, p_kind, v_fingerprint,
            case when v_tz_valid then p_client_timezone end,
            case when p_kind = 'activity'
                 then fn_local_activity_dates(p_intervals, case when v_tz_valid then p_client_timezone else 'UTC' end) end,
            case when p_kind = 'activity' then case when v_tz_valid then 'local' else 'utc_fallback' end end);

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

revoke execute on function fn_apply_study_flush(uuid, text, uuid, uuid, text, jsonb, uuid, numeric, text, boolean) from public, anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- 4. Library (one card per video)
-- -------------------------------------------------------------------------
--
-- Anchored on user_videos; every learning fact comes from the authoritative
-- tables. Per card:
--   round      — the active round if there is one, else the latest round
--                (started_at, id); its progress is fn_round_progress.
--   listening  — resolved INDEPENDENTLY of any round, against the video's
--                current ready revision (the null-transcript row when the
--                video has no ready revision). hasHistory = any Listening
--                row for the video under any revision.
--   state      — in_progress: active round with valid practice;
--                completed: any completed round (a video can be completed
--                  AND have a newer active round — then it is in_progress
--                  with hasCompletedRound);
--                listening: Listening progress on the current revision;
--                listening_prior_revision: Listening history only under
--                  another revision (never "not started");
--                not_started: none of the above.
--   lastActivityAt = latest of membership, round, Listening and
--                study-session timestamps.
-- Sorted lastActivityAt desc, videoId asc; offset/limit (max 50).
create or replace function fn_video_library(p_limit integer default 20, p_offset integer default 0, p_filter text default 'all')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_filter text := coalesce(nullif(p_filter, ''), 'all');
  v_result jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if v_filter not in ('all', 'continue', 'in_progress', 'completed', 'not_started', 'listening') then
    raise exception 'invalid_payload';
  end if;

  with facts as (
    select uv.youtube_video_id as vid, uv.added_at, uv.last_mode, v.title,
           cr.id as round_id, cr.status as round_status, cr.provenance as round_provenance,
           cr.round_number, cr.transcript_id as round_transcript_id, cr.started_at as round_started_at,
           cr.completed_at as round_completed_at, cr.current_segment_index as round_segment_index,
           coalesce(cr.status = 'active' and (
             exists (select 1 from attempt_logs a where a.session_id = cr.id and a.is_practice_valid)
             or exists (select 1 from shadowing_attempts sa where sa.round_id = cr.id and sa.is_practice_valid)), false) as round_practiced,
           coalesce(rs.has_verified, false) as has_verified,
           coalesce(rs.has_legacy, false) as has_legacy,
           coalesce(rs.completed_count, 0)::integer as completed_count,
           ct.id as current_transcript_id,
           lp.id is not null as lp_found,
           lp.coverage_ratio as lp_coverage,
           coalesce(lp.listened_through, false) as lp_through,
           lp.last_position_sec as lp_position,
           (lp.id is not null and (lp.covered_sec > 0 or lp.last_position_sec > 0)) as lp_active,
           exists (select 1 from listening_progress h where h.user_id = v_user and h.youtube_video_id = uv.youtube_video_id) as listen_any,
           greatest(
             uv.added_at, rs.last_round_at,
             (select max(p.updated_at) from listening_progress p where p.user_id = v_user and p.youtube_video_id = uv.youtube_video_id),
             (select max(s.last_activity_at) from study_sessions s where s.user_id = v_user and s.youtube_video_id = uv.youtube_video_id)
           ) as last_activity_at
      from user_videos uv
      left join videos v on v.youtube_video_id = uv.youtube_video_id
      left join lateral (
        select r.* from learning_sessions r
         where r.user_id = v_user and r.youtube_video_id = uv.youtube_video_id
         order by (r.status = 'active') desc, r.started_at desc, r.id desc
         limit 1) cr on true
      left join lateral (
        select bool_or(r.status = 'completed' and r.provenance = 'current') as has_verified,
               bool_or(r.status = 'completed' and r.provenance = 'legacy_unverified') as has_legacy,
               count(*) filter (where r.status = 'completed') as completed_count,
               max(r.updated_at) as last_round_at
          from learning_sessions r
         where r.user_id = v_user and r.youtube_video_id = uv.youtube_video_id) rs on true
      left join lateral (
        select t.id from transcripts t
         where t.youtube_video_id = uv.youtube_video_id and t.language = 'en' and t.is_current and t.status = 'ready'
         limit 1) ct on true
      left join lateral (
        select p.* from listening_progress p
         where p.user_id = v_user and p.youtube_video_id = uv.youtube_video_id
           and ((ct.id is not null and p.transcript_id = ct.id)
                or (ct.id is null and p.transcript_id is null and p.superseded_at is null))
         limit 1) lp on true
     where uv.user_id = v_user
  ),
  cards as (
    select f.*,
           case
             when f.round_status = 'active' and f.round_practiced then 'in_progress'
             when f.has_verified or f.has_legacy then 'completed'
             when f.lp_active then 'listening'
             when f.listen_any then 'listening_prior_revision'
             else 'not_started'
           end as state
      from facts f
  ),
  filtered as (
    select c.* from cards c
     where v_filter = 'all'
        or (v_filter = 'continue' and (c.state = 'in_progress' or (c.state = 'listening' and not c.lp_through)))
        or (v_filter = 'in_progress' and c.state = 'in_progress')
        or (v_filter = 'completed' and (c.has_verified or c.has_legacy))
        or (v_filter = 'not_started' and c.state = 'not_started')
        or (v_filter = 'listening' and c.listen_any)
  ),
  page as (
    select * from filtered order by last_activity_at desc, vid asc offset v_offset limit v_limit
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'videoId', p.vid,
        'title', p.title,
        'addedAt', p.added_at,
        'lastActivityAt', p.last_activity_at,
        'lastMode', p.last_mode,
        'state', p.state,
        'hasCompletedRound', p.has_verified,
        'hasLegacyCompletion', p.has_legacy,
        'completedRoundCount', p.completed_count,
        'round', case when p.round_id is null then null else jsonb_build_object(
          'roundId', p.round_id,
          'status', p.round_status,
          'provenance', p.round_provenance,
          'roundNumber', p.round_number,
          'transcriptId', p.round_transcript_id,
          'startedAt', p.round_started_at,
          'completedAt', p.round_completed_at,
          'currentSegmentIndex', p.round_segment_index,
          'progress', fn_round_progress(p.round_id)
        ) end,
        'listening', jsonb_build_object(
          'transcriptId', p.current_transcript_id,
          'coverageRatio', case when p.lp_found and p.current_transcript_id is not null then p.lp_coverage end,
          'listenedThrough', p.lp_through,
          'lastPositionSec', case when p.lp_found then p.lp_position end,
          'hasHistory', p.listen_any,
          'historyOnOtherRevision', p.listen_any and not p.lp_active
        )
      ) order by p.last_activity_at desc, p.vid asc) from page p), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'limit', v_limit,
    'offset', v_offset,
    'filter', v_filter
  ) into v_result;

  return v_result || jsonb_build_object(
    'hasMore', v_offset + jsonb_array_length(v_result->'items') < (v_result->>'total')::integer
  );
end;
$$;

-- -------------------------------------------------------------------------
-- 5. Dashboard (§6.8) and activity days
-- -------------------------------------------------------------------------

create or replace function fn_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_counts jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;

  with rounds as (
    select r.id, r.youtube_video_id, r.status, r.provenance from learning_sessions r where r.user_id = v_user
  ),
  verified as (
    select distinct youtube_video_id from rounds where status = 'completed' and provenance = 'current'
  )
  select jsonb_build_object(
    'completedVideos', (select count(*) from verified),
    -- Videos whose ONLY completions are unverified legacy ones — a video
    -- already counted as verified is never counted again here.
    'legacyCompletedVideos', (
      select count(distinct r.youtube_video_id) from rounds r
       where r.status = 'completed' and r.provenance = 'legacy_unverified'
         and r.youtube_video_id not in (select youtube_video_id from verified)),
    -- May overlap completedVideos: a completed video with a newer active
    -- round that has real practice is both.
    'inProgressVideos', (
      select count(distinct r.youtube_video_id) from rounds r
       where r.status = 'active'
         and (exists (select 1 from attempt_logs a where a.session_id = r.id and a.is_practice_valid)
              or exists (select 1 from shadowing_attempts sa where sa.round_id = r.id and sa.is_practice_valid))),
    'listenedThroughVideos', (
      select count(distinct p.youtube_video_id) from listening_progress p where p.user_id = v_user and p.listened_through),
    'libraryVideos', (select count(*) from user_videos uv where uv.user_id = v_user)
  ) into v_counts;

  return v_counts || jsonb_build_object(
    'sentenceAccuracy', fn_dictation_accuracy_summary(v_user, null),
    'shadowing', fn_shadowing_summary(v_user, null),
    'activeTime', fn_activity_union(v_user, null, null)
  );
end;
$$;

-- Calendar days (YYYY-MM-DD, newest first, last 400 days) with recorded
-- practice in ANY mode. Day rules, in order:
--   1. Activity batches (engaged wall-clock time from Dictation input,
--      hints, submissions, playback incl. Listening, recording): the dates
--      stored with the batch — local dates in its captured timezone, or UTC
--      dates (utc_fallback) when it carried no valid timezone.
--   2. Study sessions with NO dated batch (recorded before 040): UTC dates
--      of their activity intervals — the documented historical fallback;
--      a past timezone is never guessed.
--   3. Dictation answers and Shadowing takes: local date in the timezone of
--      the nearest-in-time local batch of THEIR OWN study session; UTC when
--      that session has none (legacy answers, sessions before 040).
-- A date counts once however many events fall on it. Returns
-- { days, utcFallbackDays } — utcFallbackDays lists dates known ONLY from
-- UTC-fallback sources. "Today" is not decided here: the caller compares
-- these dates with the viewer's local date.
create or replace function fn_activity_days()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_since timestamptz := now() - interval '400 days';
  v_result jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;

  with my_sessions as (
    select s.id, s.activity_intervals from study_sessions s
     where s.user_id = v_user and s.last_activity_at >= v_since
  ),
  dated as (
    select l.study_session_id, l.activity_dates, l.day_basis
      from activity_flush_log l join my_sessions m on m.id = l.study_session_id
     where l.kind = 'activity' and l.activity_dates is not null
  ),
  answers as (
    select a.created_at, a.study_session_id
      from attempt_logs a join learning_sessions r on r.id = a.session_id
     where r.user_id = v_user and a.created_at >= v_since
    union all
    select sa.created_at, sa.study_session_id from shadowing_attempts sa
     where sa.user_id = v_user and sa.created_at >= v_since
  ),
  all_days as (
    select d, day_basis = 'utc_fallback' as fallback
      from dated cross join lateral unnest(activity_dates) d
    union all
    select gs::date, true
      from my_sessions m
      cross join lateral jsonb_array_elements(m.activity_intervals) e
      cross join lateral generate_series(
        (to_timestamp((e->>'start')::float8) at time zone 'UTC')::date,
        (to_timestamp(greatest((e->>'start')::float8, (e->>'end')::float8 - 0.001)) at time zone 'UTC')::date,
        interval '1 day') gs
     where not exists (select 1 from dated x where x.study_session_id = m.id)
    union all
    select (r.created_at at time zone coalesce(z.client_timezone, 'UTC'))::date, z.client_timezone is null
      from answers r
      left join lateral (
        select x.client_timezone from activity_flush_log x
         where r.study_session_id is not null and x.study_session_id = r.study_session_id
           and x.kind = 'activity' and x.day_basis = 'local'
         order by abs(extract(epoch from x.processed_at - r.created_at)), x.processed_at
         limit 1) z on true
  ),
  per_day as (
    select d, bool_and(fallback) as only_fallback from all_days
     where d >= (v_since at time zone 'UTC')::date
     group by d
  )
  select jsonb_build_object(
    'days', coalesce(jsonb_agg(to_char(d, 'YYYY-MM-DD') order by d desc), '[]'::jsonb),
    'utcFallbackDays', coalesce(jsonb_agg(to_char(d, 'YYYY-MM-DD') order by d desc) filter (where only_fallback), '[]'::jsonb)
  ) into v_result
  from per_day;
  return v_result;
end;
$$;

-- -------------------------------------------------------------------------
-- 6. Study-session History
-- -------------------------------------------------------------------------
--
-- One entry per study session, newest first (started_at desc, id desc),
-- keyset-paginated. Per session:
--   dictation/shadowing: distinct ELIGIBLE sentences with valid practice
--     attributed to this session; overlap = in both; unique = union.
--   newlyCoveredInRound: sentences whose FIRST valid practice in the round
--     (either mode) was attributed to this session. "First" is decided at
--     read time by (created_at, mode: dictation before shadowing, id) —
--     timestamp order with a stable tie-breaker, not commit order.
--   activeSec: union of this session's own activity intervals (estimate);
--   elapsedSpanSec: last_activity_at - started_at (bookkeeping span).
--   listeningObservedSec: replay-inclusive MEDIA seconds (not wall clock at
--     non-1× speed); listeningNewlyCoveredSec: what it added to coverage.
create or replace function fn_history_sessions(
  p_limit integer default 20,
  p_before_started_at timestamptz default null,
  p_before_id uuid default null,
  p_video text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
  v_count integer;
  v_unattributed jsonb := null;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if (p_before_started_at is null) <> (p_before_id is null) then raise exception 'invalid_payload'; end if;
  if p_video is not null and not fn_valid_video_id(p_video) then raise exception 'invalid_payload'; end if;

  with page as (
    select s.* from study_sessions s
     where s.user_id = v_user
       and (p_video is null or s.youtube_video_id = p_video)
       and (p_before_started_at is null or (s.started_at, s.id) < (p_before_started_at, p_before_id))
     order by s.started_at desc, s.id desc
     limit v_limit + 1
  )
  select coalesce(jsonb_agg(entry order by started_at desc, id desc), '[]'::jsonb), count(*)
    into v_rows, v_count
  from (
    select p.started_at, p.id, jsonb_build_object(
      'studySessionId', p.id,
      'videoId', p.youtube_video_id,
      'title', v.title,
      'roundId', p.round_id,
      'roundNumber', r.round_number,
      'roundStatus', r.status,
      'roundProvenance', r.provenance,
      'startedAt', p.started_at,
      'lastActivityAt', p.last_activity_at,
      'endedAt', p.ended_at,
      'modesUsed', p.modes_used,
      'elapsedSpanSec', round(extract(epoch from (p.last_activity_at - p.started_at))::numeric, 1),
      'activeSec', round(fn_intervals_union_length(p.activity_intervals), 1),
      'listeningObservedSec', round(p.listening_observed_sec, 1),
      'listeningNewlyCoveredSec', round(p.listening_newly_covered_sec, 1),
      'dictationSentences', st.d,
      'shadowingSentences', st.s,
      'overlapSentences', st.o,
      'uniqueSentences', st.u,
      'newlyCoveredInRound', st.n,
      'dictationLatest', st.latest
    ) as entry
    from page p
    left join videos v on v.youtube_video_id = p.youtube_video_id
    left join learning_sessions r on r.id = p.round_id
    left join lateral (
      with eligible as (
        select ts.segment_index from transcript_segments ts
         where ts.transcript_id = r.transcript_id and ts.text_normalized <> ''
      ),
      d as (
        select distinct a.segment_index from attempt_logs a join eligible e using (segment_index)
         where a.study_session_id = p.id and a.session_id = p.round_id and a.is_practice_valid
      ),
      s as (
        select distinct sa.segment_index from shadowing_attempts sa join eligible e using (segment_index)
         where sa.study_session_id = p.id and sa.round_id = p.round_id and sa.is_practice_valid
      ),
      firsts as (
        select distinct on (x.segment_index) x.segment_index, x.study_session_id
          from (
            select a.segment_index, a.created_at, 0 as src, a.id, a.study_session_id
              from attempt_logs a where a.session_id = p.round_id and a.is_practice_valid
            union all
            select sa.segment_index, sa.created_at, 1, sa.id, sa.study_session_id
              from shadowing_attempts sa where sa.round_id = p.round_id and sa.is_practice_valid
          ) x
          join eligible e using (segment_index)
         order by x.segment_index, x.created_at, x.src, x.id
      ),
      latest_in_session as (
        select distinct on (a.segment_index) a.is_correct
          from attempt_logs a
         where a.study_session_id = p.id and a.session_id = p.round_id and a.is_practice_valid
         order by a.segment_index, a.created_at desc, a.id desc
      )
      select (select count(*) from d)::integer as d,
             (select count(*) from s)::integer as s,
             (select count(*) from (select segment_index from d intersect select segment_index from s) i)::integer as o,
             (select count(*) from (select segment_index from d union select segment_index from s) un)::integer as u,
             (select count(*) from firsts f where f.study_session_id = p.id)::integer as n,
             (select jsonb_build_object('correct', count(*) filter (where is_correct), 'practiced', count(*))
                from latest_in_session) as latest
    ) st on true
  ) q;

  if p_before_started_at is null then
    -- Practice that no study session can own: rounds from before study
    -- sessions existed (unverified legacy) and late answers recorded with no
    -- open session. Labeled, never grouped into invented sessions.
    select jsonb_build_object(
      'legacyRounds', count(*) filter (where r.provenance = 'legacy_unverified'),
      'unattributedAnswers', coalesce(sum((select count(*) from attempt_logs a where a.session_id = r.id and a.study_session_id is null)), 0),
      'unattributedTakes', coalesce(sum((select count(*) from shadowing_attempts sa where sa.round_id = r.id and sa.study_session_id is null)), 0)
    ) into v_unattributed
    from learning_sessions r
    where r.user_id = v_user and (p_video is null or r.youtube_video_id = p_video);
  end if;

  return jsonb_build_object(
    'items', case when v_count > v_limit
                  then (select jsonb_agg(e order by ord) from jsonb_array_elements(v_rows) with ordinality t(e, ord) where ord <= v_limit)
                  else v_rows end,
    'hasMore', v_count > v_limit,
    'unattributed', v_unattributed
  );
end;
$$;

-- -------------------------------------------------------------------------
-- 7. Whole-round report
-- -------------------------------------------------------------------------
--
-- Scope: the caller's own round (user + roundId + its pinned transcript),
-- across every study session of that round. Never combines rounds.
--   Dictation (valid practice only, ordered by created_at then id):
--     sentence accuracy  = correct LATEST answers / Dictation-practiced
--                          sentences (same rule as fn_round_progress);
--     submissions        = stored logical submissions (an idempotent retry
--                          is one row);
--     first try          = the FIRST recorded answer per sentence — only
--                          when the round's history is complete (a verified
--                          round with no unverified legacy answers);
--     needs review       = latest answer incorrect;
--     corrected          = latest answer correct after a recorded incorrect one;
--     best streak        = longest run of consecutive correct answers across
--                          the whole round (a wrong answer ends a run);
--                          omitted when the history is incomplete.
--   Shadowing: the independent Azure / Word Match summaries for the round.
create or replace function fn_round_report(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_round record;
  v_complete boolean;
  v_sentences jsonb;
  v_totals jsonb;
  v_streak integer;
  v_submissions integer;
  v_invalid integer;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_round_id is null then raise exception 'invalid_payload'; end if;

  select r.id, r.youtube_video_id, r.transcript_id, r.status, r.provenance, r.round_number,
         r.required_sentence_count, r.started_at, r.updated_at, r.completed_at, r.completed_at_approximate,
         r.current_segment_index, v.title
    into v_round
    from learning_sessions r
    left join videos v on v.youtube_video_id = r.youtube_video_id
   where r.id = p_round_id and r.user_id = v_user;
  if not found then raise exception 'round_not_found'; end if;

  v_complete := v_round.provenance = 'current'
    and not exists (select 1 from attempt_logs a
                     where a.session_id = p_round_id and a.segment_identity_provenance <> 'verified');

  with da as (
    select a.*,
           row_number() over (partition by a.segment_index order by a.created_at, a.id) as rn_first,
           row_number() over (partition by a.segment_index order by a.created_at desc, a.id desc) as rn_last
      from attempt_logs a
     where a.session_id = p_round_id and a.is_practice_valid
  ),
  dsum as (
    select segment_index,
           count(*) as practice_submissions,
           bool_or(not is_correct) as ever_incorrect,
           max(case when rn_first = 1 then (case when is_correct then 1 else 0 end) end) as first_correct,
           max(case when rn_first = 1 then hint_level_used end) as first_hint,
           max(case when rn_first = 1 then user_text end) as first_text,
           max(case when rn_last = 1 then (case when is_correct then 1 else 0 end) end) as latest_correct,
           max(case when rn_last = 1 then user_text end) as latest_text,
           max(case when rn_last = 1 then error_type end) as latest_error,
           max(case when rn_last = 1 then id::text end) as latest_id,
           max(case when rn_last = 1 then created_at end) as latest_at
      from da group by segment_index
  ),
  dall as (
    select segment_index, count(*) as submissions from attempt_logs where session_id = p_round_id group by segment_index
  ),
  ssum as (
    select sa.segment_index,
           count(*) as takes,
           count(*) filter (where sa.is_practice_valid) as valid_takes,
           (select jsonb_build_object('pronunciationScore', x.azure_pronunciation_score, 'evaluatedAt', x.azure_evaluated_at, 'attemptId', x.id)
              from shadowing_attempts x
             where x.round_id = p_round_id and x.segment_index = sa.segment_index and x.azure_eval_status = 'completed'
             order by x.created_at desc, x.id desc limit 1) as latest_azure,
           (select jsonb_build_object('accuracy', x.word_match_accuracy, 'completeness', x.word_match_completeness, 'attemptId', x.id)
              from shadowing_attempts x
             where x.round_id = p_round_id and x.segment_index = sa.segment_index and x.word_match_status = 'completed'
             order by x.created_at desc, x.id desc limit 1) as latest_word_match
      from shadowing_attempts sa
     where sa.round_id = p_round_id
     group by sa.segment_index
  ),
  idx as (
    select segment_index from dall union select segment_index from ssum
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'segmentIndex', i.segment_index,
           'text', ts.text_raw,
           'eligible', coalesce(ts.text_normalized <> '', false),
           'category', case
             when d.segment_index is null then 'shadowing_only'
             when d.latest_correct = 0 then 'needs_review'
             when d.ever_incorrect then 'corrected'
             when v_complete and d.first_correct = 1 then 'first_try'
             else 'correct' end,
           'dictation', case when dl.segment_index is null then null else jsonb_build_object(
             'submissions', dl.submissions,
             'practiceSubmissions', coalesce(d.practice_submissions, 0),
             'first', case when d.segment_index is null or not v_complete then null else jsonb_build_object(
               'correct', d.first_correct = 1, 'hintLevel', d.first_hint, 'userText', d.first_text) end,
             'latest', case when d.segment_index is null then null else jsonb_build_object(
               'correct', d.latest_correct = 1, 'userText', d.latest_text, 'errorType', d.latest_error,
               'attemptId', d.latest_id, 'createdAt', d.latest_at) end,
             'everIncorrect', coalesce(d.ever_incorrect, false)) end,
           'shadowing', case when s.segment_index is null then null else jsonb_build_object(
             'takes', s.takes, 'validTakes', s.valid_takes,
             'latestAzure', s.latest_azure, 'latestWordMatch', s.latest_word_match) end
         ) order by i.segment_index), '[]'::jsonb)
    into v_sentences
    from idx i
    left join transcript_segments ts on ts.transcript_id = v_round.transcript_id and ts.segment_index = i.segment_index
    left join dsum d on d.segment_index = i.segment_index
    left join dall dl on dl.segment_index = i.segment_index
    left join ssum s on s.segment_index = i.segment_index;

  -- Longest run of consecutive correct answers over the whole round.
  with o as (
    select is_correct, row_number() over (order by created_at, id) as rn
      from attempt_logs where session_id = p_round_id and is_practice_valid
  ),
  g as (
    select is_correct, rn - row_number() over (partition by is_correct order by rn) as grp from o
  )
  select coalesce(max(cnt), 0) into v_streak
    from (select count(*) as cnt from g where is_correct group by grp) runs;

  select count(*), count(*) filter (where not is_practice_valid) into v_submissions, v_invalid
    from attempt_logs where session_id = p_round_id;

  select jsonb_build_object(
    'practicedSentences', count(*) filter (where (e->'dictation'->'latest') is not null and jsonb_typeof(e->'dictation'->'latest') = 'object'),
    'latestCorrect', count(*) filter (where (e->'dictation'->'latest'->>'correct')::boolean),
    'needsReview', count(*) filter (where e->>'category' = 'needs_review'),
    'corrected', count(*) filter (where e->>'category' = 'corrected'),
    'firstTry', jsonb_build_object(
      'available', v_complete,
      'correct', case when v_complete then count(*) filter (where (e->'dictation'->'first'->>'correct')::boolean) end,
      'correctWithHint', case when v_complete then count(*) filter (
        where (e->'dictation'->'first'->>'correct')::boolean and (e->'dictation'->'first'->>'hintLevel')::integer > 0) end,
      'correctHintUnknown', case when v_complete then count(*) filter (
        where (e->'dictation'->'first'->>'correct')::boolean and jsonb_typeof(e->'dictation'->'first'->'hintLevel') = 'null') end
    )
  ) into v_totals
  from jsonb_array_elements(v_sentences) e;

  return jsonb_build_object(
    'round', jsonb_build_object(
      'roundId', v_round.id,
      'videoId', v_round.youtube_video_id,
      'title', v_round.title,
      'transcriptId', v_round.transcript_id,
      'status', v_round.status,
      'provenance', v_round.provenance,
      'roundNumber', v_round.round_number,
      'requiredSentenceCount', v_round.required_sentence_count,
      'startedAt', v_round.started_at,
      'updatedAt', v_round.updated_at,
      'completedAt', v_round.completed_at,
      'completedAtApproximate', v_round.completed_at_approximate,
      'currentSegmentIndex', v_round.current_segment_index
    ),
    'historyComplete', v_complete,
    'progress', fn_round_progress(p_round_id),
    'dictation', v_totals || jsonb_build_object(
      'submissions', v_submissions,
      'invalidSubmissions', v_invalid,
      'bestStreak', case when v_complete and v_submissions > 0 then v_streak end,
      'accuracy', fn_dictation_accuracy_summary(v_user, p_round_id)
    ),
    'shadowing', fn_shadowing_summary(v_user, p_round_id),
    'activity', fn_activity_union(v_user, p_round_id, null) || jsonb_build_object(
      'unattributedAnswers', (select count(*) from attempt_logs a where a.session_id = p_round_id and a.study_session_id is null),
      'unattributedTakes', (select count(*) from shadowing_attempts sa where sa.round_id = p_round_id and sa.study_session_id is null)
    ),
    'sentences', v_sentences
  );
end;
$$;

-- The caller's own round progress (coverage, attempt count, latest-answer
-- accuracy) — fn_round_progress itself is internal. Used by the resume read
-- so a reopened practice page shows the round's real coverage.
create or replace function fn_my_round_progress(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if p_round_id is null then raise exception 'invalid_payload'; end if;
  perform 1 from learning_sessions where id = p_round_id and user_id = auth.uid();
  if not found then raise exception 'round_not_found'; end if;
  return fn_round_progress(p_round_id);
end;
$$;

-- -------------------------------------------------------------------------
-- 8. Membership reconciliation (operator-only; one-time, re-runnable)
-- -------------------------------------------------------------------------
--
-- Nothing wrote user_videos after the 027 backfill, so videos first used
-- after Phase 1 have no Library entry. This adds membership for every
-- (user, video) with REAL activity — rounds, Listening progress, study
-- sessions, Shadowing takes — except pairs the user removed. added_at is the
-- earliest evidence. Existing rows are never changed. Safe to re-run. Never
-- called on a Library read.
create or replace function fn_phase6_reconcile_membership()
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
  v_removed integer;
begin
  -- Membership writers from the app (add / remove / mode / automatic add)
  -- wait for this one-time statement instead of racing it, so a removal
  -- committed concurrently can never be undone by the reconciliation.
  lock table user_videos, user_video_removals in share row exclusive mode;

  with evidence as (
    select user_id, youtube_video_id, started_at as at from learning_sessions where user_id is not null
    union all select user_id, youtube_video_id, created_at from listening_progress
    union all select user_id, youtube_video_id, started_at from study_sessions
    union all select user_id, youtube_video_id, created_at from shadowing_attempts
  ),
  pairs as (
    select e.user_id, e.youtube_video_id, min(e.at) as first_at
      from evidence e join users u on u.id = e.user_id
     group by e.user_id, e.youtube_video_id
  )
  select count(*) into v_removed from pairs p
   where exists (select 1 from user_video_removals x where x.user_id = p.user_id and x.youtube_video_id = p.youtube_video_id)
     and not exists (select 1 from user_videos uv where uv.user_id = p.user_id and uv.youtube_video_id = p.youtube_video_id);

  with evidence as (
    select user_id, youtube_video_id, started_at as at from learning_sessions where user_id is not null
    union all select user_id, youtube_video_id, created_at from listening_progress
    union all select user_id, youtube_video_id, started_at from study_sessions
    union all select user_id, youtube_video_id, created_at from shadowing_attempts
  ),
  pairs as (
    select e.user_id, e.youtube_video_id, min(e.at) as first_at
      from evidence e join users u on u.id = e.user_id
     group by e.user_id, e.youtube_video_id
  )
  insert into user_videos (user_id, youtube_video_id, added_at, last_activity_at)
  select p.user_id, p.youtube_video_id, p.first_at, p.first_at from pairs p
   where not exists (select 1 from user_video_removals x where x.user_id = p.user_id and x.youtube_video_id = p.youtube_video_id)
  on conflict (user_id, youtube_video_id) do nothing;
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('inserted', v_inserted, 'skippedRemoved', v_removed);
end;
$$;

-- Read-only: (user, video) pairs with real activity but no membership and
-- no removal — what the reconciliation would add. Operator-only.
create or replace function fn_phase6_membership_gap()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from (
    select distinct e.user_id, e.youtube_video_id from (
      select user_id, youtube_video_id from learning_sessions where user_id is not null
      union select user_id, youtube_video_id from listening_progress
      union select user_id, youtube_video_id from study_sessions
      union select user_id, youtube_video_id from shadowing_attempts
    ) e
    join users u on u.id = e.user_id
    where not exists (select 1 from user_videos uv where uv.user_id = e.user_id and uv.youtube_video_id = e.youtube_video_id)
      and not exists (select 1 from user_video_removals x where x.user_id = e.user_id and x.youtube_video_id = e.youtube_video_id)
  ) gap;
$$;

-- -------------------------------------------------------------------------
-- 9. Privileges (explicit; PUBLIC's default EXECUTE revoked everywhere)
-- -------------------------------------------------------------------------

revoke all on function fn_library_add_video(text, boolean) from public, anon, service_role;
revoke all on function fn_library_remove_video(text) from public, anon, service_role;
revoke all on function fn_set_video_last_mode(text, text) from public, anon, service_role;
revoke all on function fn_video_last_mode(text) from public, anon, service_role;
revoke all on function fn_video_library(integer, integer, text) from public, anon, service_role;
revoke all on function fn_dashboard_summary() from public, anon, service_role;
revoke all on function fn_activity_days() from public, anon, service_role;
revoke all on function fn_history_sessions(integer, timestamptz, uuid, text) from public, anon, service_role;
revoke all on function fn_round_report(uuid) from public, anon, service_role;
revoke all on function fn_my_round_progress(uuid) from public, anon, service_role;

grant execute on function fn_library_add_video(text, boolean) to authenticated;
grant execute on function fn_library_remove_video(text) to authenticated;
grant execute on function fn_set_video_last_mode(text, text) to authenticated;
grant execute on function fn_video_last_mode(text) to authenticated;
grant execute on function fn_video_library(integer, integer, text) to authenticated;
grant execute on function fn_dashboard_summary() to authenticated;
grant execute on function fn_activity_days() to authenticated;
grant execute on function fn_history_sessions(integer, timestamptz, uuid, text) to authenticated;
grant execute on function fn_round_report(uuid) to authenticated;
grant execute on function fn_my_round_progress(uuid) to authenticated;

revoke all on function fn_phase6_reconcile_membership() from public, anon, authenticated, service_role;
revoke all on function fn_phase6_membership_gap() from public, anon, authenticated, service_role;
