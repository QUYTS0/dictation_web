-- =====================================================
-- 042 — Practice History grouped by video
--
-- History changes from one entry per study session (040's
-- fn_history_sessions, kept unchanged) to one entry per VIDEO with learning
-- history. Grouping happens here, on the server, so pagination is by video:
-- a video never repeats on a later page and its totals never depend on how
-- many of its sessions were loaded. Nothing is merged or rewritten — every
-- study session, round, attempt and transcript association stays as it is.
--
--   fn_history_videos         — one card per studied video, keyset-paged by
--                                (last learning activity desc, video id asc)
--   fn_history_video_rounds   — a video's rounds (on demand, bounded)
--   fn_history_video_sessions — the study sessions of ONE round, or the
--                                video's round-less (Listening-only) sessions
--                                (on demand, keyset-paged)
--
-- All three are SECURITY DEFINER reads scoped to auth.uid(), callable by
-- authenticated only, and write nothing (no Library membership, no round).
-- See .claude/video-learning-management-plan.md (History) and
-- supabase/PHASE6_RUNBOOK.md.
-- =====================================================

-- -------------------------------------------------------------------------
-- 1. History list — one card per video with ACTUAL learning history
-- -------------------------------------------------------------------------
--
-- A video has learning history when the user has any of:
--   * a study session (created only by real practice / activity flushes);
--   * a recorded Dictation answer or Shadowing take;
--   * a completed round (incl. unverified legacy completions with no
--     recorded answers);
--   * Listening progress with coverage or a checkpoint.
-- A video that was only added to the Library, or a round created but never
-- practiced, is NOT history. Library membership is irrelevant: a removed
-- video keeps its history (and inLibrary = false); a read never re-adds it.
--
-- lastActivityAt = the latest of those events (never "round row updated").
-- Per card, the DEFAULT round is the active round if any, else the latest
-- (started_at desc, id desc); its coverage is fn_round_progress (unique
-- sentences of that round — never a sum of per-session counts).
-- activeSec = union of the wall-clock activity intervals of ALL the video's
-- study sessions (overlap counted once) — an estimate, since tracking began.
-- Listening is reported against the video's current revision only.
create or replace function fn_history_videos(
  p_limit integer default 10,
  p_before_last_activity_at timestamptz default null,
  p_before_video text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_result jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if (p_before_last_activity_at is null) <> (p_before_video is null) then raise exception 'invalid_payload'; end if;
  if p_before_video is not null and not fn_valid_video_id(p_before_video) then raise exception 'invalid_payload'; end if;

  with evidence as (
    select s.youtube_video_id as vid, max(s.last_activity_at) as at
      from study_sessions s where s.user_id = v_user group by 1
    union all
    select r.youtube_video_id, max(a.created_at)
      from attempt_logs a join learning_sessions r on r.id = a.session_id
     where r.user_id = v_user group by 1
    union all
    select sa.youtube_video_id, max(sa.created_at)
      from shadowing_attempts sa where sa.user_id = v_user group by 1
    union all
    select r.youtube_video_id, max(coalesce(r.completed_at, r.updated_at))
      from learning_sessions r where r.user_id = v_user and r.status = 'completed' group by 1
    union all
    select p.youtube_video_id, max(p.updated_at)
      from listening_progress p
     where p.user_id = v_user and (p.covered_sec > 0 or p.last_position_sec > 0) group by 1
  ),
  studied as (
    select vid, max(at) as last_at from evidence group by vid
  ),
  page as (
    select * from studied
     where p_before_last_activity_at is null
        or last_at < p_before_last_activity_at
        or (last_at = p_before_last_activity_at and vid > p_before_video)
     order by last_at desc, vid asc
     limit v_limit + 1
  ),
  cards as (
    select pg.vid, pg.last_at, v.title,
           (select count(*) from study_sessions s where s.user_id = v_user and s.youtube_video_id = pg.vid)::integer as session_count,
           (select count(*) from learning_sessions r where r.user_id = v_user and r.youtube_video_id = pg.vid)::integer as round_count,
           dr.id as round_id, dr.round_number, dr.status as round_status, dr.provenance as round_provenance,
           dr.started_at as round_started_at, dr.completed_at as round_completed_at,
           exists (select 1 from user_videos uv where uv.user_id = v_user and uv.youtube_video_id = pg.vid) as in_library,
           ct.id as current_transcript_id,
           lp.id is not null as lp_found, lp.coverage_ratio as lp_coverage,
           coalesce(lp.listened_through, false) as lp_through,
           exists (select 1 from listening_progress h where h.user_id = v_user and h.youtube_video_id = pg.vid) as listen_any,
           (select round(fn_intervals_union_length(coalesce(jsonb_agg(e) filter (where e is not null), '[]'::jsonb)), 1)
              from study_sessions s left join lateral jsonb_array_elements(s.activity_intervals) e on true
             where s.user_id = v_user and s.youtube_video_id = pg.vid) as active_sec
      from page pg
      left join videos v on v.youtube_video_id = pg.vid
      left join lateral (
        select r.* from learning_sessions r
         where r.user_id = v_user and r.youtube_video_id = pg.vid
         order by (r.status = 'active') desc, r.started_at desc, r.id desc
         limit 1) dr on true
      left join lateral (
        select t.id from transcripts t
         where t.youtube_video_id = pg.vid and t.language = 'en' and t.is_current and t.status = 'ready'
         limit 1) ct on true
      left join lateral (
        select p.* from listening_progress p
         where p.user_id = v_user and p.youtube_video_id = pg.vid
           and ((ct.id is not null and p.transcript_id = ct.id)
                or (ct.id is null and p.transcript_id is null and p.superseded_at is null))
         limit 1) lp on true
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'videoId', c.vid,
        'title', c.title,
        'lastActivityAt', c.last_at,
        'sessionCount', c.session_count,
        'roundCount', c.round_count,
        'inLibrary', c.in_library,
        'activeSec', c.active_sec,
        'round', case when c.round_id is null then null else jsonb_build_object(
          'roundId', c.round_id,
          'roundNumber', c.round_number,
          'status', c.round_status,
          'provenance', c.round_provenance,
          'startedAt', c.round_started_at,
          'completedAt', c.round_completed_at,
          'progress', fn_round_progress(c.round_id)
        ) end,
        'listening', jsonb_build_object(
          'transcriptId', c.current_transcript_id,
          'coverageRatio', case when c.lp_found and c.current_transcript_id is not null then c.lp_coverage end,
          'listenedThrough', c.lp_through,
          'hasHistory', c.listen_any
        )
      ) order by c.last_at desc, c.vid asc)
      from (select * from cards order by last_at desc, vid asc limit v_limit) c), '[]'::jsonb),
    'hasMore', (select count(*) from page) > v_limit,
    'total', (select count(*) from studied)
  ) into v_result;
  return v_result;
end;
$$;

-- -------------------------------------------------------------------------
-- 2. A video's rounds (expanded card) — newest first, bounded
-- -------------------------------------------------------------------------
create or replace function fn_history_video_rounds(p_video text, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_default uuid;
  v_result jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not fn_valid_video_id(p_video) then raise exception 'invalid_payload'; end if;

  select r.id into v_default from learning_sessions r
   where r.user_id = v_user and r.youtube_video_id = p_video
   order by (r.status = 'active') desc, r.started_at desc, r.id desc limit 1;

  with rounds as (
    select r.* from learning_sessions r
     where r.user_id = v_user and r.youtube_video_id = p_video
     order by r.started_at desc, r.id desc
     limit v_limit + 1
  )
  select jsonb_build_object(
    'videoId', p_video,
    'defaultRoundId', v_default,
    'rounds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'roundId', r.id,
        'roundNumber', r.round_number,
        'status', r.status,
        'provenance', r.provenance,
        'transcriptId', r.transcript_id,
        'startedAt', r.started_at,
        'completedAt', r.completed_at,
        'sessionCount', (select count(*) from study_sessions s where s.user_id = v_user and s.round_id = r.id),
        -- Practice no study session owns (answers from before sessions were
        -- tracked, late answers with no open session) — labeled, never
        -- folded into an invented session.
        'unattributedAnswers', (select count(*) from attempt_logs a where a.session_id = r.id and a.study_session_id is null),
        'unattributedTakes', (select count(*) from shadowing_attempts sa where sa.round_id = r.id and sa.study_session_id is null),
        'progress', fn_round_progress(r.id)
      ) order by r.started_at desc, r.id desc)
      from (select * from rounds order by started_at desc, id desc limit v_limit) r), '[]'::jsonb),
    'hasMore', (select count(*) from rounds) > v_limit,
    -- Listening-only sittings: kept separate, never attached to a round.
    'roundlessSessionCount', (select count(*) from study_sessions s
                               where s.user_id = v_user and s.youtube_video_id = p_video and s.round_id is null)
  ) into v_result;
  return v_result;
end;
$$;

-- -------------------------------------------------------------------------
-- 3. Study sessions of ONE round, or the video's round-less sessions
-- -------------------------------------------------------------------------
--
-- Same per-session entry as 040's fn_history_sessions (the definitions are
-- documented there), filtered to the selected round — or, with
-- p_roundless, to the video's sessions with no round. Keyset-paged by
-- (started_at desc, id desc).
create or replace function fn_history_video_sessions(
  p_video text,
  p_round_id uuid default null,
  p_roundless boolean default false,
  p_limit integer default 10,
  p_before_started_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_rows jsonb;
  v_count integer;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not fn_valid_video_id(p_video) then raise exception 'invalid_payload'; end if;
  -- Exactly one of: a round, or the round-less sessions.
  if (p_round_id is not null and coalesce(p_roundless, false)) or (p_round_id is null and not coalesce(p_roundless, false)) then
    raise exception 'invalid_payload';
  end if;
  if (p_before_started_at is null) <> (p_before_id is null) then raise exception 'invalid_payload'; end if;
  if p_round_id is not null then
    perform 1 from learning_sessions where id = p_round_id and user_id = v_user and youtube_video_id = p_video;
    if not found then raise exception 'round_not_found'; end if;
  end if;

  with page as (
    select s.* from study_sessions s
     where s.user_id = v_user and s.youtube_video_id = p_video
       and ((p_round_id is not null and s.round_id = p_round_id) or (p_round_id is null and s.round_id is null))
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
      'roundId', p.round_id,
      'startedAt', p.started_at,
      'lastActivityAt', p.last_activity_at,
      'endedAt', p.ended_at,
      'modesUsed', p.modes_used,
      'elapsedSpanSec', round(extract(epoch from (p.last_activity_at - p.started_at))::numeric, 1),
      'activeSec', round(fn_intervals_union_length(p.activity_intervals), 1),
      'listeningObservedSec', round(p.listening_observed_sec, 1),
      'listeningNewlyCoveredSec', round(p.listening_newly_covered_sec, 1),
      'dictationSentences', coalesce(st.d, 0),
      'shadowingSentences', coalesce(st.s, 0),
      'overlapSentences', coalesce(st.o, 0),
      'uniqueSentences', coalesce(st.u, 0),
      'newlyCoveredInRound', coalesce(st.n, 0),
      'dictationLatest', coalesce(st.latest, jsonb_build_object('correct', 0, 'practiced', 0))
    ) as entry
    from page p
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
    ) st on p.round_id is not null
  ) q;

  return jsonb_build_object(
    'items', case when v_count > v_limit
                  then (select jsonb_agg(e order by ord) from jsonb_array_elements(v_rows) with ordinality t(e, ord) where ord <= v_limit)
                  else v_rows end,
    'hasMore', v_count > v_limit
  );
end;
$$;

-- -------------------------------------------------------------------------
-- 4. Privileges (exact signatures; PUBLIC's default EXECUTE revoked)
-- -------------------------------------------------------------------------

revoke all on function fn_history_videos(integer, timestamptz, text) from public, anon, service_role;
revoke all on function fn_history_video_rounds(text, integer) from public, anon, service_role;
revoke all on function fn_history_video_sessions(text, uuid, boolean, integer, timestamptz, uuid) from public, anon, service_role;

grant execute on function fn_history_videos(integer, timestamptz, text) to authenticated;
grant execute on function fn_history_video_rounds(text, integer) to authenticated;
grant execute on function fn_history_video_sessions(text, uuid, boolean, integer, timestamptz, uuid) to authenticated;
