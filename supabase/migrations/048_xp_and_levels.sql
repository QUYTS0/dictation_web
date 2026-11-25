-- =====================================================
-- 048 — XP, calculated from the records already stored (rules v1)
-- =====================================================
--
-- Dashboard redesign, Phase 5 (.claude/dashboard-redesign-plan.md §3.3,
-- decision D1). Nothing here writes: XP is CALCULATED on read from the
-- timestamped practice records (and 046's review log), so the recording
-- functions stay untouched, existing learners get XP for past practice,
-- and a total can never drift from the records it comes from.
--
-- XP_RULES_VERSION = 1. Every rule pays only its FIRST occurrence (retries,
-- repeat takes and "Again" loops earn nothing extra):
--
--   dictation_sentence  +10  first practice-valid Dictation answer to a
--                            sentence in a round           (that answer)
--   dictation_correct    +5  first CORRECT practice-valid answer to it
--                            in that round                 (that answer)
--   shadowing_sentence  +10  first practice-valid Shadowing take of a
--                            sentence in a round           (that take)
--   shadowing_score      +5  first practice-valid take of it in that round
--                            with Azure pronunciation >= 80 (that take)
--   listening      +1 / min  whole minutes of newly covered Listening per
--                            study session                 (session start —
--                            the counter has no per-update time)
--   vocabulary           +3  first review of a word per local day, at most
--                            20 paid per day (60 XP); later reviews that
--                            day are listed with 0          (that review)
--   round_complete      +50  verified round completion (provenance
--                            'current'; legacy and abandoned rounds: none)
--   active_day          +10  any recorded activity that local day (answers,
--                            takes, word reviews, engaged time) (its first
--                            moment)
--
-- XP never depends on a preference (the daily goal earns nothing). The two
-- "local day" rules use ONE zone per learner — their most recently recorded
-- browser timezone (fn_xp_time_zone; UTC if none) — so a total is the same
-- wherever it is shown (Dashboard, header, the league board in Phase 7).
-- Changing a rule changes historical totals: bump the version and announce.
--
--   fn_xp_time_zone            internal: the learner's XP zone
--   fn_xp_events               internal: every XP event of a learner
--   fn_active_seconds_between  internal: engaged seconds in a time window
--   fn_my_xp                   the caller's totals, league-week XP, last
--                              week's recap and 14 local days
--
-- Reads only; re-runnable. Apply after 047.
-- =====================================================

begin;

-- The learner's most recently recorded valid browser timezone (activity
-- batches and word reviews store one); UTC when there is none.
create or replace function fn_xp_time_zone(p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
begin
  select t.tz into v_tz from (
    select l.client_timezone as tz, l.processed_at as at
      from activity_flush_log l join study_sessions s on s.id = l.study_session_id
     where s.user_id = p_user_id and l.client_timezone is not null
    union all
    select vr.client_timezone, vr.reviewed_at
      from vocabulary_reviews vr
     where vr.user_id = p_user_id and vr.client_timezone is not null
  ) t
  order by t.at desc
  limit 1;
  return case when fn_valid_time_zone(v_tz) then v_tz else 'UTC' end;
end;
$$;

create or replace function fn_xp_events(p_user_id uuid, p_time_zone text)
returns table (occurred_at timestamptz, source text, amount integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with dictation as (
    select a.id, a.session_id, a.segment_index, a.is_correct, a.created_at
      from attempt_logs a join learning_sessions r on r.id = a.session_id
     where r.user_id = p_user_id and a.is_practice_valid
  ),
  dictation_first as (
    select distinct on (session_id, segment_index) created_at
      from dictation order by session_id, segment_index, created_at, id
  ),
  dictation_correct as (
    select distinct on (session_id, segment_index) created_at
      from dictation where is_correct order by session_id, segment_index, created_at, id
  ),
  shadowing as (
    select sa.id, sa.round_id, sa.segment_index, sa.created_at, sa.azure_eval_status, sa.azure_pronunciation_score
      from shadowing_attempts sa
     where sa.user_id = p_user_id and sa.is_practice_valid
  ),
  shadowing_first as (
    select distinct on (round_id, segment_index) created_at
      from shadowing order by round_id, segment_index, created_at, id
  ),
  shadowing_score as (
    select distinct on (round_id, segment_index) created_at
      from shadowing
     where azure_eval_status = 'completed' and azure_pronunciation_score >= 80
     order by round_id, segment_index, created_at, id
  ),
  listening as (
    select s.started_at, floor(s.listening_newly_covered_sec / 60)::integer as minutes
      from study_sessions s
     where s.user_id = p_user_id and s.listening_newly_covered_sec >= 60
  ),
  -- A deleted word keeps its reviews (item_id null): each counts on its own.
  review_days as (
    select distinct on (coalesce(vr.item_id, vr.id), (vr.reviewed_at at time zone p_time_zone)::date)
           vr.id, vr.reviewed_at, (vr.reviewed_at at time zone p_time_zone)::date as d
      from vocabulary_reviews vr
     where vr.user_id = p_user_id
     order by coalesce(vr.item_id, vr.id), (vr.reviewed_at at time zone p_time_zone)::date, vr.reviewed_at, vr.id
  ),
  reviews as (
    select reviewed_at, row_number() over (partition by d order by reviewed_at, id) as n from review_days
  ),
  completions as (
    select r.completed_at
      from learning_sessions r
     where r.user_id = p_user_id and r.status = 'completed' and r.provenance = 'current' and r.completed_at is not null
  ),
  -- Every recorded moment of activity, for the active-day bonus. An engaged
  -- interval that runs past local midnight is also a moment of the next
  -- day, starting at that midnight.
  moments as (
    select a.created_at as at
      from attempt_logs a join learning_sessions r on r.id = a.session_id
     where r.user_id = p_user_id
    union all
    select sa.created_at from shadowing_attempts sa where sa.user_id = p_user_id
    union all
    select vr.reviewed_at from vocabulary_reviews vr where vr.user_id = p_user_id
    union all
    select greatest(to_timestamp((e->>'start')::float8), gs at time zone p_time_zone)
      from study_sessions s
      cross join lateral jsonb_array_elements(s.activity_intervals) e
      cross join lateral generate_series(
        (to_timestamp((e->>'start')::float8) at time zone p_time_zone)::date::timestamp,
        (to_timestamp(greatest((e->>'start')::float8, (e->>'end')::float8 - 0.001)) at time zone p_time_zone)::date::timestamp,
        interval '1 day') gs
     where s.user_id = p_user_id
  ),
  active_days as (
    select min(at) as at from moments group by (at at time zone p_time_zone)::date
  )
  select created_at, 'dictation_sentence', 10 from dictation_first
  union all select created_at, 'dictation_correct', 5 from dictation_correct
  union all select created_at, 'shadowing_sentence', 10 from shadowing_first
  union all select created_at, 'shadowing_score', 5 from shadowing_score
  union all select started_at, 'listening', minutes from listening
  union all select reviewed_at, 'vocabulary', case when n <= 20 then 3 else 0 end from reviews
  union all select completed_at, 'round_complete', 50 from completions
  union all select at, 'active_day', 10 from active_days;
$$;

-- Engaged seconds inside [p_lo, p_hi): the union of the learner's activity
-- intervals (two tabs count once — fn_activity_union's rule), clipped.
create or replace function fn_active_seconds_between(p_user_id uuid, p_lo timestamptz, p_hi timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select round(coalesce(sum(least((m->>'end')::numeric, extract(epoch from p_hi))
                            - greatest((m->>'start')::numeric, extract(epoch from p_lo))), 0), 1)
    from jsonb_array_elements(fn_merge_intervals((
      select coalesce(jsonb_agg(e), '[]'::jsonb)
        from study_sessions s
        cross join lateral jsonb_array_elements(s.activity_intervals) e
       where s.user_id = p_user_id
         and (e->>'end')::numeric > extract(epoch from p_lo)
         and (e->>'start')::numeric < extract(epoch from p_hi)
    ))) m;
$$;

-- The caller's XP. p_time_zone (the viewer's browser zone) only decides
-- which local dates `today` and `days` are; the rules themselves use the
-- learner's XP zone, so totals don't move with the viewer's browser.
--   totalXp, todayXp
--   leagueWeekStart / leagueWeekXp — the league week: Monday 00:00 UTC to
--                     the next (one global boundary, plan §3.5)
--   lastLeagueWeek  — the week before: { weekStart, xp, activeSec,
--                     wordsReviewed (distinct words) } — the Monday recap
--   days            — 14 local days ending today, oldest first:
--                     { date, xp, activity: { dictationSentences,
--                     shadowingSentences, wordsReviewed, listeningMin } } —
--                     the number of first-occurrence events per source
--                     (wordsReviewed includes reviews past the daily cap)
create or replace function fn_my_xp(p_time_zone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_xp_tz text;
  v_today date;
  v_from date;
  v_week timestamptz;
  v_result jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not fn_valid_time_zone(p_time_zone) then raise exception 'invalid_payload'; end if;

  v_xp_tz := fn_xp_time_zone(v_user);
  v_today := (now() at time zone p_time_zone)::date;
  v_from := v_today - 13;
  v_week := date_trunc('week', now() at time zone 'UTC') at time zone 'UTC';

  with ev as materialized (
    select * from fn_xp_events(v_user, v_xp_tz)
  ),
  per_day as (
    select (occurred_at at time zone p_time_zone)::date as d,
           sum(amount) as xp,
           count(*) filter (where source = 'dictation_sentence') as dictation,
           count(*) filter (where source = 'shadowing_sentence') as shadowing,
           count(*) filter (where source = 'vocabulary') as words,
           coalesce(sum(amount) filter (where source = 'listening'), 0) as listening
      from ev
     where occurred_at >= (v_from::timestamp at time zone p_time_zone)
     group by 1
  )
  select jsonb_build_object(
    'rulesVersion', 1,
    'timeZone', p_time_zone,
    'xpTimeZone', v_xp_tz,
    'today', to_char(v_today, 'YYYY-MM-DD'),
    'totalXp', (select coalesce(sum(amount), 0) from ev),
    'todayXp', (select coalesce(sum(xp), 0) from per_day where d = v_today),
    'leagueWeekStart', v_week,
    'leagueWeekXp', (select coalesce(sum(amount), 0) from ev where occurred_at >= v_week and occurred_at < v_week + interval '7 days'),
    'lastLeagueWeek', jsonb_build_object(
      'weekStart', to_char((v_week - interval '7 days') at time zone 'UTC', 'YYYY-MM-DD'),
      'xp', (select coalesce(sum(amount), 0) from ev where occurred_at >= v_week - interval '7 days' and occurred_at < v_week),
      'activeSec', fn_active_seconds_between(v_user, v_week - interval '7 days', v_week),
      'wordsReviewed', (select count(distinct coalesce(vr.item_id, vr.id)) from vocabulary_reviews vr
                         where vr.user_id = v_user and vr.reviewed_at >= v_week - interval '7 days' and vr.reviewed_at < v_week)
    ),
    'days', (
      select jsonb_agg(jsonb_build_object(
               'date', to_char(g.d, 'YYYY-MM-DD'),
               'xp', coalesce(p.xp, 0),
               'activity', jsonb_build_object(
                 'dictationSentences', coalesce(p.dictation, 0),
                 'shadowingSentences', coalesce(p.shadowing, 0),
                 'wordsReviewed', coalesce(p.words, 0),
                 'listeningMin', coalesce(p.listening, 0)))
             order by g.d)
        from (select gs::date as d from generate_series(v_from::timestamp, v_today::timestamp, interval '1 day') gs) g
        left join per_day p on p.d = g.d
    )
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function fn_xp_time_zone(uuid) from public, anon, authenticated, service_role;
revoke all on function fn_xp_events(uuid, text) from public, anon, authenticated, service_role;
revoke all on function fn_active_seconds_between(uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function fn_my_xp(text) from public, anon, authenticated, service_role;
grant execute on function fn_my_xp(text) to authenticated;

commit;
