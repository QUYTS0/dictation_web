-- =====================================================
-- 047 — Profile preferences and active time per local day
-- =====================================================
--
-- Dashboard redesign, Phase 4 (.claude/dashboard-redesign-plan.md §3.2,
-- decision D3): the hero's Today's target and weekly track, and the 7-day
-- bars under "Est. active practice".
--
--   users.daily_goal_minutes  — the learner's daily target in minutes; NULL
--                               means the app default (15). Never feeds XP.
--   users.public_name         — optional name for the public boards (Phase 7;
--   users.leaderboard_hidden    nothing reads these two until then)
--   fn_public_nickname        — internal: the stable pseudonym shown when no
--                               public name is set (Phase 7)
--   fn_my_profile             — the caller's preferences
--   fn_update_my_profile      — the validated preference write (a patch:
--                               only the keys present change)
--   fn_daily_activity         — engaged seconds per LOCAL calendar day
--
-- The CHECK constraints are the backstop: users_self_update (001) also lets
-- a signed-in user PATCH their own row directly, which must not be able to
-- store a value fn_update_my_profile would refuse.
--
-- Deploy order: apply BEFORE deploying the app version that calls these
-- functions (until then /api/dashboard/week and /api/profile answer 503 and
-- the hero hides its target and track). Re-runnable.
-- See supabase/DASHBOARD_REDESIGN_RUNBOOK.md.
-- =====================================================

begin;

-- -------------------------------------------------------------------------
-- 1. Preference columns
-- -------------------------------------------------------------------------

alter table users add column if not exists daily_goal_minutes smallint null;
alter table users add column if not exists public_name text null;
alter table users add column if not exists leaderboard_hidden boolean not null default false;

alter table users drop constraint if exists users_daily_goal_minutes_check;
alter table users add constraint users_daily_goal_minutes_check
  check (daily_goal_minutes is null or daily_goal_minutes in (10, 15, 20, 30, 45, 60));

-- 2–24 characters, already trimmed with single spaces; no control
-- characters and none of < > @ / \ : (so never an email, a URL or markup);
-- never shaped like a generated nickname ("Learner 4F2A2"), so nobody can
-- pose as another learner's pseudonym.
alter table users drop constraint if exists users_public_name_check;
alter table users add constraint users_public_name_check
  check (public_name is null or (
    char_length(public_name) between 2 and 24
    and public_name = btrim(public_name)
    and public_name !~ '\s\s'
    and public_name !~ '[[:cntrl:]<>@/\\:]'
    and public_name !~* '^learner [0-9a-f]{5}$'
  ));

comment on column users.daily_goal_minutes is
  '047: daily active-practice target in minutes (10/15/20/30/45/60); NULL = '
  'the app default of 15. A preference only: it never changes XP or metrics.';
comment on column users.public_name is
  '047: optional name shown on public boards (Phase 7). NULL = the generated '
  'nickname (fn_public_nickname). display_name is NOT reused for this.';
comment on column users.leaderboard_hidden is
  '047: true = left out of every public board (Phase 7).';

-- -------------------------------------------------------------------------
-- 2. Profile read and write
-- -------------------------------------------------------------------------

-- Deterministic, needs no column, and not derivable from the email.
create or replace function fn_public_nickname(p_user_id uuid)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select 'Learner ' || upper(substr(md5(p_user_id::text || ':league'), 1, 5));
$$;

create or replace function fn_my_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_name text;
  v_goal smallint;
  v_hidden boolean;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  select u.public_name, u.daily_goal_minutes, u.leaderboard_hidden
    into v_name, v_goal, v_hidden
    from users u where u.id = v_user;
  return jsonb_build_object(
    'publicName', v_name,
    'nickname', fn_public_nickname(v_user),
    'leaderboardHidden', coalesce(v_hidden, false),
    'dailyGoalMinutes', v_goal
  );
end;
$$;

-- p_patch: any of {"publicName": text|null, "dailyGoalMinutes": number|null,
-- "leaderboardHidden": boolean}. A key that is absent is left unchanged;
-- null clears a name or goal (back to the nickname / the default goal). The
-- name is trimmed and inner whitespace collapsed; an empty name clears it.
-- Any unknown key, wrong type or value outside the rules → 'invalid_payload'
-- and nothing is changed. Returns the updated fn_my_profile().
create or replace function fn_update_my_profile(p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_name text;
  v_goal numeric;
  v_hidden boolean;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'invalid_payload';
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('publicName', 'dailyGoalMinutes', 'leaderboardHidden') then raise exception 'invalid_payload'; end if;
  end loop;

  if p_patch ? 'publicName' then
    if jsonb_typeof(p_patch->'publicName') = 'string' then
      v_name := nullif(regexp_replace(btrim(p_patch->>'publicName', E' \t\r\n'), '\s+', ' ', 'g'), '');
    elsif jsonb_typeof(p_patch->'publicName') <> 'null' then
      raise exception 'invalid_payload';
    end if;
  end if;

  if p_patch ? 'dailyGoalMinutes' then
    if jsonb_typeof(p_patch->'dailyGoalMinutes') = 'number' then
      v_goal := (p_patch->>'dailyGoalMinutes')::numeric;
      if v_goal not in (10, 15, 20, 30, 45, 60) then raise exception 'invalid_payload'; end if;
    elsif jsonb_typeof(p_patch->'dailyGoalMinutes') <> 'null' then
      raise exception 'invalid_payload';
    end if;
  end if;

  if p_patch ? 'leaderboardHidden' then
    if jsonb_typeof(p_patch->'leaderboardHidden') <> 'boolean' then raise exception 'invalid_payload'; end if;
    v_hidden := (p_patch->>'leaderboardHidden')::boolean;
  end if;

  begin
    update users set
      public_name = case when p_patch ? 'publicName' then v_name else public_name end,
      daily_goal_minutes = case when p_patch ? 'dailyGoalMinutes' then v_goal::smallint else daily_goal_minutes end,
      leaderboard_hidden = case when p_patch ? 'leaderboardHidden' then v_hidden else leaderboard_hidden end
    where id = v_user;
  exception when check_violation then
    raise exception 'invalid_payload';
  end;

  return fn_my_profile();
end;
$$;

-- -------------------------------------------------------------------------
-- 3. Active time per local day
-- -------------------------------------------------------------------------

-- [{date: 'YYYY-MM-DD', activeSec}] for every local date from p_from to
-- p_to (at most 31 days), oldest first, in the IANA zone p_time_zone.
-- Same rule as fn_activity_union (040), the Dashboard's "Est. active
-- practice": the UNION of engaged wall-clock intervals across all of the
-- caller's study sessions (two tabs at once count once), here cut at each
-- local midnight. Midnights come from the tz database, so DST days of 23 or
-- 25 hours are handled, and consecutive days share their boundary — the
-- days of a range add up to exactly the union inside it. An interval that
-- runs across midnight counts on both days, each for its own part. Days
-- with nothing recorded are 0. The day set of the STREAK is a separate read
-- (fn_activity_days): it also counts answers and word reviews, which carry
-- no measured time.
create or replace function fn_daily_activity(p_time_zone text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_lo numeric;
  v_hi numeric;
  v_merged jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 30
     or not fn_valid_time_zone(p_time_zone) then
    raise exception 'invalid_payload';
  end if;

  v_lo := extract(epoch from (p_from::timestamp at time zone p_time_zone));
  v_hi := extract(epoch from ((p_to + 1)::timestamp at time zone p_time_zone));

  select fn_merge_intervals(coalesce(jsonb_agg(e), '[]'::jsonb)) into v_merged
    from study_sessions s
    cross join lateral jsonb_array_elements(s.activity_intervals) e
   where s.user_id = v_user
     and (e->>'end')::numeric > v_lo
     and (e->>'start')::numeric < v_hi;

  return (
    select coalesce(jsonb_agg(jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'), 'activeSec', d.sec) order by d.day), '[]'::jsonb)
      from (
        -- FILTER, not a bare sum: least()/greatest() ignore NULLs, so a day
        -- with no interval would otherwise count as a whole day.
        select b.day,
               round(coalesce(sum(least((m->>'end')::numeric, b.day_end) - greatest((m->>'start')::numeric, b.day_start))
                                filter (where m is not null), 0), 1) as sec
          from (
            select gs::date as day,
                   extract(epoch from (gs::date::timestamp at time zone p_time_zone)) as day_start,
                   extract(epoch from ((gs::date + 1)::timestamp at time zone p_time_zone)) as day_end
              from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs
          ) b
          left join jsonb_array_elements(v_merged) m
            on (m->>'end')::numeric > b.day_start and (m->>'start')::numeric < b.day_end
         group by b.day
      ) d
  );
end;
$$;

-- -------------------------------------------------------------------------
-- 4. Privileges
-- -------------------------------------------------------------------------

revoke all on function fn_public_nickname(uuid) from public, anon, authenticated, service_role;
revoke all on function fn_my_profile() from public, anon, authenticated, service_role;
revoke all on function fn_update_my_profile(jsonb) from public, anon, authenticated, service_role;
revoke all on function fn_daily_activity(text, date, date) from public, anon, authenticated, service_role;

grant execute on function fn_my_profile() to authenticated;
grant execute on function fn_update_my_profile(jsonb) to authenticated;
grant execute on function fn_daily_activity(text, date, date) to authenticated;

commit;
