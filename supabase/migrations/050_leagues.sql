-- =====================================================
-- 050 — Weekly leagues, kudos, all-time board, League achievement
-- =====================================================
--
-- Dashboard redesign, Phase 7 (.claude/dashboard-redesign-plan.md §3.5,
-- decisions D2, D5–D7).
--
--   Leagues: Bronze(1) → Silver → Gold → Platinum → Diamond → Master(6).
--   A league week is [Monday 00:00 UTC, next Monday). Members of a group
--   (≤ 30, same tier) are ranked by that week's XP (048: calculated, the
--   learner's own XP zone), then by who joined first.
--
--   Joining   on a board read: a learner who isn't hidden and has XP this
--             week joins the first group of their tier with room, or a new one.
--   Rollover  lazy and idempotent, on any board read, under an advisory lock:
--             each past group's top 3 move up (not from Master), its bottom 3
--             move down when it has ≥ 10 ranked members (not from Bronze).
--             No cron.
--   Privacy   (D7) everyone takes part under a generated nickname unless they
--             set a public name (047) or hide. Boards return names, initials,
--             XP, streaks and kudos — NEVER an email, auth user id or avatar.
--             Hidden learners are on no board and see none; a membership made
--             before hiding stays (rollover integrity) but is not shown, not
--             ranked and keeps its tier. The tables below are readable by no
--             application role: every read goes through the functions.
--
--   fn_activity_days_of     internal: 046's day rule for any learner;
--                           fn_activity_days() now wraps it (same result)
--   fn_league_week_of / _week_xp / _display_name / _streak   internal helpers
--   fn_league_rollover / _join / _refresh_alltime            internal writers
--   fn_league_board(scope)  'week' = the caller's group, 'all' = global top 5
--                           (hourly snapshot) — the only read
--   fn_league_give_kudos    one per giver → receiver per week, same group
--   fn_sync_achievements    gains the League track (Silver → Diamond reached)
--
-- Apply after 049; re-runnable.
-- =====================================================

begin;

-- -------------------------------------------------------------------------
-- 1. Practice days for any learner (046's rule, unchanged)
-- -------------------------------------------------------------------------

create or replace function fn_activity_days_of(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := p_user_id;
  v_since timestamptz := now() - interval '400 days';
  v_result jsonb;
begin
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
  reviews as (
    select (vr.reviewed_at at time zone coalesce(vr.client_timezone, 'UTC'))::date as d,
           vr.client_timezone is null as fallback
      from vocabulary_reviews vr
     where vr.user_id = v_user and vr.reviewed_at >= v_since
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
    union all
    select d, fallback from reviews
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

-- Same signature, privileges and result as 046: the caller's days.
create or replace function fn_activity_days()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  return fn_activity_days_of(auth.uid());
end;
$$;

revoke all on function fn_activity_days_of(uuid) from public, anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- 2. Tables (no application role may read or write any of them)
-- -------------------------------------------------------------------------

create table if not exists user_league_state (
  user_id uuid primary key references users(id) on delete cascade,
  tier smallint not null default 1 check (tier between 1 and 6),
  updated_at timestamptz not null default now()
);

create table if not exists league_weeks (
  week_start date primary key check (extract(isodow from week_start) = 1),
  finalized_at timestamptz null
);

create table if not exists league_groups (
  id uuid primary key default gen_random_uuid(),
  week_start date not null references league_weeks (week_start) on delete cascade,
  tier smallint not null check (tier between 1 and 6),
  created_at timestamptz not null default now()
);
create index if not exists league_groups_week_tier_idx on league_groups (week_start, tier, created_at);

create table if not exists league_members (
  -- The opaque key boards hand out (never the user id).
  id uuid primary key default gen_random_uuid(),
  week_start date not null references league_weeks (week_start) on delete cascade,
  group_id uuid not null references league_groups (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  final_rank smallint null,
  final_xp integer null,
  outcome text null check (outcome in ('promoted', 'stayed', 'demoted')),
  unique (week_start, user_id)
);
create index if not exists league_members_group_idx on league_members (group_id);

create table if not exists league_kudos (
  week_start date not null references league_weeks (week_start) on delete cascade,
  giver_id uuid not null references users (id) on delete cascade,
  receiver_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (week_start, giver_id, receiver_id),
  check (giver_id <> receiver_id)
);
create index if not exists league_kudos_receiver_idx on league_kudos (week_start, receiver_id);

create table if not exists leaderboard_alltime (
  user_id uuid primary key references users (id) on delete cascade,
  total_xp integer not null,
  refreshed_at timestamptz not null default now()
);

create table if not exists leaderboard_alltime_refresh (
  singleton boolean primary key default true check (singleton),
  refreshed_at timestamptz not null
);

do $$
declare
  t text;
begin
  foreach t in array array['user_league_state', 'league_weeks', 'league_groups', 'league_members', 'league_kudos',
                           'leaderboard_alltime', 'leaderboard_alltime_refresh'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

-- -------------------------------------------------------------------------
-- 3. Helpers
-- -------------------------------------------------------------------------

-- The Monday (UTC) of the league week an instant falls in.
create or replace function fn_league_week_of(p_at timestamptz)
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (date_trunc('week', p_at at time zone 'UTC'))::date;
$$;

-- A learner's XP inside one league week (048's events, their XP zone) —
-- the same number fn_my_xp reports as leagueWeekXp.
create or replace function fn_league_week_xp(p_user_id uuid, p_week date)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(e.amount), 0)::integer
    from fn_xp_events(p_user_id, fn_xp_time_zone(p_user_id)) e
   where e.occurred_at >= (p_week::timestamp at time zone 'UTC')
     and e.occurred_at < ((p_week + 7)::timestamp at time zone 'UTC');
$$;

create or replace function fn_league_display_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select u.public_name from users u where u.id = p_user_id), fn_public_nickname(p_user_id));
$$;

-- A learner's current streak, counted back from today in their XP zone
-- (their most recently recorded one) — the board's other members.
create or replace function fn_league_streak(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select fn_streak_from_days(
    coalesce((select array_agg(x::date) from jsonb_array_elements_text(fn_activity_days_of(p_user_id)->'days') x), '{}'::date[]),
    (now() at time zone fn_xp_time_zone(p_user_id))::date);
$$;

-- -------------------------------------------------------------------------
-- 4. Rollover, joining, the all-time snapshot
-- -------------------------------------------------------------------------

create or replace function fn_league_rollover()
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_current date := fn_league_week_of(now());
  v_week date;
  v_group record;
begin
  -- Cheap check first: most reads have nothing to finalize and take no lock.
  if not exists (select 1 from league_weeks where finalized_at is null and week_start < v_current) then return; end if;
  perform pg_advisory_xact_lock(50, hashtext('league_rollover'));

  -- Re-read under the lock: a concurrent read may have finalized already.
  for v_week in select week_start from league_weeks where finalized_at is null and week_start < v_current order by week_start loop
    for v_group in select id, tier from league_groups where week_start = v_week loop
      with scored as materialized (
        select m.id, m.user_id, m.joined_at, coalesce(u.leaderboard_hidden, false) as hidden,
               fn_league_week_xp(m.user_id, v_week) as xp
          from league_members m left join users u on u.id = m.user_id
         where m.group_id = v_group.id
      ),
      ranked as (
        select s.id, row_number() over (order by s.xp desc, s.joined_at, s.id) as rnk, count(*) over () as n
          from scored s where not s.hidden
      ),
      decided as (
        select s.id, s.user_id, s.xp, r.rnk,
               case
                 when r.rnk is null then 'stayed' -- hidden: not ranked, keeps the tier
                 when r.rnk <= 3 and v_group.tier < 6 and s.xp > 0 then 'promoted'
                 when r.n >= 10 and r.rnk > r.n - 3 and v_group.tier > 1 then 'demoted'
                 else 'stayed'
               end as outcome
          from scored s left join ranked r on r.id = s.id
      ),
      updated as (
        update league_members m
           set final_rank = d.rnk, final_xp = d.xp, outcome = d.outcome
          from decided d
         where m.id = d.id
        returning m.user_id, d.outcome
      )
      insert into user_league_state (user_id, tier, updated_at)
      select user_id, v_group.tier + case outcome when 'promoted' then 1 when 'demoted' then -1 else 0 end, now()
        from updated
      on conflict (user_id) do update set tier = excluded.tier, updated_at = excluded.updated_at;
    end loop;
    update league_weeks set finalized_at = now() where week_start = v_week;
  end loop;
end;
$$;

-- Places a learner in this week's league if eligible (not hidden, XP this
-- week). Returns their membership id, or null.
create or replace function fn_league_join(p_user_id uuid, p_week date)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_member uuid;
  v_tier smallint;
  v_group uuid;
begin
  select id into v_member from league_members where week_start = p_week and user_id = p_user_id;
  if found then return v_member; end if;
  if coalesce((select leaderboard_hidden from users where id = p_user_id), true) then return null; end if;
  if fn_league_week_xp(p_user_id, p_week) <= 0 then return null; end if;

  insert into user_league_state (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select tier into v_tier from user_league_state where user_id = p_user_id;
  insert into league_weeks (week_start) values (p_week) on conflict (week_start) do nothing;

  -- One placement at a time per (week, tier): a group never exceeds 30.
  perform pg_advisory_xact_lock(50, hashtext('league_join:' || p_week::text || ':' || v_tier::text));
  select id into v_member from league_members where week_start = p_week and user_id = p_user_id;
  if found then return v_member; end if;

  select g.id into v_group
    from league_groups g
   where g.week_start = p_week and g.tier = v_tier
     and (select count(*) from league_members m where m.group_id = g.id) < 30
   order by g.created_at, g.id
   limit 1;
  if v_group is null then
    insert into league_groups (week_start, tier) values (p_week, v_tier) returning id into v_group;
  end if;

  insert into league_members (week_start, group_id, user_id) values (p_week, v_group, p_user_id)
  on conflict (week_start, user_id) do nothing
  returning id into v_member;
  if v_member is null then
    select id into v_member from league_members where week_start = p_week and user_id = p_user_id;
  end if;
  return v_member;
end;
$$;

-- Recomputes the all-time snapshot when it is over an hour old. One
-- recompute at a time: a read that can't take the lock serves the current
-- snapshot.
create or replace function fn_league_refresh_alltime()
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
begin
  select refreshed_at into v_at from leaderboard_alltime_refresh;
  if v_at is not null and v_at > now() - interval '1 hour' then return; end if;
  if not pg_try_advisory_xact_lock(50, hashtext('league_alltime')) then return; end if;
  select refreshed_at into v_at from leaderboard_alltime_refresh;
  if v_at is not null and v_at > now() - interval '1 hour' then return; end if;

  delete from leaderboard_alltime;
  insert into leaderboard_alltime (user_id, total_xp, refreshed_at)
  select u.id, x.total, now()
    from users u
    cross join lateral (select coalesce(sum(e.amount), 0)::integer as total from fn_xp_events(u.id, fn_xp_time_zone(u.id)) e) x
   where not u.leaderboard_hidden and x.total > 0;
  insert into leaderboard_alltime_refresh (singleton, refreshed_at) values (true, now())
  on conflict (singleton) do update set refreshed_at = excluded.refreshed_at;
end;
$$;

-- -------------------------------------------------------------------------
-- 5. The board and kudos
-- -------------------------------------------------------------------------

-- p_scope 'week': { status: member | not_joined | hidden, tier, rows: [{ rank,
--   memberKey, name, weekXp, streakDays, kudos, youGaveKudos, isYou, zone }] }
-- p_scope 'all':  { status: member | hidden, rows: [{ rank, name, totalXp,
--   isYou }] (top 5), you: { rank, totalXp } | null, refreshedAt }
-- Both: scope, weekStart, weekEndsAt, displayName (how the caller appears),
-- lastWeek: { weekStart, tier, outcome, finalRank, xp } | null.
-- zone: promotion (top 3, not Master, XP > 0) | demotion (bottom 3 of a
-- group of ≥ 10, not Bronze) | safe — the rollover's rule, live.
create or replace function fn_league_board(p_scope text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_week date;
  v_hidden boolean;
  v_tier smallint;
  v_group uuid;
  v_group_tier smallint;
  v_base jsonb;
  v_last jsonb;
  v_rows jsonb;
  v_you jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_scope is null or p_scope not in ('week', 'all') then raise exception 'invalid_payload'; end if;

  perform fn_league_rollover();
  v_week := fn_league_week_of(now());
  v_hidden := coalesce((select u.leaderboard_hidden from users u where u.id = v_user), false);
  v_tier := coalesce((select s.tier from user_league_state s where s.user_id = v_user), 1);

  select jsonb_build_object('weekStart', to_char(m.week_start, 'YYYY-MM-DD'), 'tier', g.tier, 'outcome', m.outcome,
                            'finalRank', m.final_rank, 'xp', m.final_xp)
    into v_last
    from league_members m join league_groups g on g.id = m.group_id
   where m.user_id = v_user and m.week_start = v_week - 7 and m.outcome is not null;

  v_base := jsonb_build_object(
    'scope', p_scope,
    'weekStart', to_char(v_week, 'YYYY-MM-DD'),
    'weekEndsAt', (v_week + 7)::timestamp at time zone 'UTC',
    'displayName', fn_league_display_name(v_user),
    'tier', v_tier,
    'lastWeek', v_last
  );
  if v_hidden then
    return v_base || jsonb_build_object('status', 'hidden', 'rows', '[]'::jsonb, 'you', null);
  end if;

  if p_scope = 'week' then
    perform fn_league_join(v_user, v_week);
    select m.group_id, g.tier into v_group, v_group_tier
      from league_members m join league_groups g on g.id = m.group_id
     where m.week_start = v_week and m.user_id = v_user;
    if v_group is null then
      return v_base || jsonb_build_object('status', 'not_joined', 'rows', '[]'::jsonb, 'you', null);
    end if;

    with visible as (
      select m.id, m.user_id, m.joined_at
        from league_members m join users u on u.id = m.user_id
       where m.group_id = v_group and not u.leaderboard_hidden
    ),
    scored as materialized (
      select v.*, fn_league_week_xp(v.user_id, v_week) as xp from visible v
    ),
    ranked as (
      select s.*, row_number() over (order by s.xp desc, s.joined_at, s.id) as rnk, count(*) over () as n from scored s
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'rank', r.rnk,
             'memberKey', r.id,
             'name', fn_league_display_name(r.user_id),
             'weekXp', r.xp,
             'streakDays', fn_league_streak(r.user_id),
             'kudos', (select count(*) from league_kudos k where k.week_start = v_week and k.receiver_id = r.user_id),
             'youGaveKudos', exists (select 1 from league_kudos k where k.week_start = v_week and k.giver_id = v_user and k.receiver_id = r.user_id),
             'isYou', r.user_id = v_user,
             'zone', case
                       when r.rnk <= 3 and v_group_tier < 6 and r.xp > 0 then 'promotion'
                       when r.n >= 10 and r.rnk > r.n - 3 and v_group_tier > 1 then 'demotion'
                       else 'safe'
                     end
           ) order by r.rnk), '[]'::jsonb)
      into v_rows
      from ranked r;

    return v_base || jsonb_build_object('status', 'member', 'tier', v_group_tier, 'rows', v_rows, 'you', null);
  end if;

  -- p_scope = 'all'
  perform fn_league_refresh_alltime();
  with visible as (
    select a.user_id, a.total_xp
      from leaderboard_alltime a join users u on u.id = a.user_id
     where not u.leaderboard_hidden
  ),
  ranked as (
    select v.*, row_number() over (order by v.total_xp desc, v.user_id) as rnk from visible v
  )
  select coalesce((select jsonb_agg(jsonb_build_object('rank', r.rnk, 'name', fn_league_display_name(r.user_id),
                                                       'totalXp', r.total_xp, 'isYou', r.user_id = v_user) order by r.rnk)
                     from ranked r where r.rnk <= 5), '[]'::jsonb),
         (select jsonb_build_object('rank', r.rnk, 'totalXp', r.total_xp) from ranked r where r.user_id = v_user)
    into v_rows, v_you;

  return v_base || jsonb_build_object('status', 'member', 'rows', v_rows, 'you', v_you,
                                      'refreshedAt', (select refreshed_at from leaderboard_alltime_refresh));
end;
$$;

create or replace function fn_league_give_kudos(p_member_key uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_week date := fn_league_week_of(now());
  v_group uuid;
  v_receiver uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_member_key is null or coalesce((select u.leaderboard_hidden from users u where u.id = v_user), false) then
    raise exception 'invalid_payload';
  end if;
  select m.group_id into v_group from league_members m where m.week_start = v_week and m.user_id = v_user;
  if v_group is null then raise exception 'invalid_payload'; end if;

  select m.user_id into v_receiver
    from league_members m join users u on u.id = m.user_id
   where m.id = p_member_key and m.week_start = v_week and m.group_id = v_group and not u.leaderboard_hidden;
  if v_receiver is null or v_receiver = v_user then raise exception 'invalid_payload'; end if;

  insert into league_kudos (week_start, giver_id, receiver_id) values (v_week, v_user, v_receiver)
  on conflict do nothing;
  return jsonb_build_object('ok', true,
    'kudos', (select count(*) from league_kudos k where k.week_start = v_week and k.receiver_id = v_receiver));
end;
$$;

-- -------------------------------------------------------------------------
-- 6. The League achievement track (049): the highest league reached
-- -------------------------------------------------------------------------

insert into achievement_tiers (track, tier, threshold) values
  ('league', 1, 2), ('league', 2, 3), ('league', 3, 4), ('league', 4, 5) -- Silver, Gold, Platinum, Diamond
on conflict (track, tier) do update set threshold = excluded.threshold;

-- 049's body plus the league metric: the highest tier the learner has
-- played in or been moved up to (1 = Bronze, nothing reached yet).
create or replace function fn_sync_achievements()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_days date[];
  v_metrics jsonb;
  v_new jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;

  select coalesce(array_agg(x::date), '{}') into v_days
    from jsonb_array_elements_text(fn_activity_days()->'days') x;

  v_metrics := jsonb_build_object(
    'flame_keeper', fn_longest_streak(v_days),
    'precision_typist', coalesce((fn_dictation_accuracy_summary(v_user, null)->>'correct')::numeric, 0),
    'shadow_master', coalesce((fn_shadowing_summary(v_user, null)->'azure'->>'evaluatedSentences')::numeric, 0),
    'lexicon', (select count(*) from vocabulary_items vi where vi.user_id = v_user),
    'immersion', round(coalesce((fn_activity_union(v_user, null, null)->>'activeSec')::numeric, 0) / 3600, 2),
    'league', greatest(
      coalesce((select s.tier from user_league_state s where s.user_id = v_user), 1),
      coalesce((select max(g.tier) from league_members m join league_groups g on g.id = m.group_id where m.user_id = v_user), 1))
  );

  with inserted as (
    insert into user_achievements (user_id, track, tier)
    select v_user, t.track, t.tier
      from achievement_tiers t
     where v_metrics ? t.track and (v_metrics->>t.track)::numeric >= t.threshold
    on conflict (user_id, track, tier) do nothing
    returning track, tier, unlocked_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('track', track, 'tier', tier, 'unlockedAt', unlocked_at)
                            order by array_position(array['flame_keeper','precision_typist','shadow_master','lexicon','immersion','league'], track), tier),
                  '[]'::jsonb)
    into v_new from inserted;

  return jsonb_build_object(
    'tracks', (
      select coalesce(jsonb_agg(jsonb_build_object('track', tr.track, 'value', coalesce(v_metrics->tr.track, '0'::jsonb), 'tiers', tr.tiers)
                                order by array_position(array['flame_keeper','precision_typist','shadow_master','lexicon','immersion','league'], tr.track)),
                      '[]'::jsonb)
        from (
          select t.track,
                 jsonb_agg(jsonb_build_object('tier', t.tier, 'threshold', t.threshold, 'unlockedAt', ua.unlocked_at) order by t.tier) as tiers
            from achievement_tiers t
            left join user_achievements ua on ua.user_id = v_user and ua.track = t.track and ua.tier = t.tier
           group by t.track
        ) tr
    ),
    'newlyUnlocked', v_new
  );
end;
$$;

-- -------------------------------------------------------------------------
-- 7. Privileges
-- -------------------------------------------------------------------------

revoke all on function fn_league_week_of(timestamptz) from public, anon, authenticated, service_role;
revoke all on function fn_league_week_xp(uuid, date) from public, anon, authenticated, service_role;
revoke all on function fn_league_display_name(uuid) from public, anon, authenticated, service_role;
revoke all on function fn_league_streak(uuid) from public, anon, authenticated, service_role;
revoke all on function fn_league_rollover() from public, anon, authenticated, service_role;
revoke all on function fn_league_join(uuid, date) from public, anon, authenticated, service_role;
revoke all on function fn_league_refresh_alltime() from public, anon, authenticated, service_role;
revoke all on function fn_league_board(text) from public, anon, authenticated, service_role;
revoke all on function fn_league_give_kudos(uuid) from public, anon, authenticated, service_role;
grant execute on function fn_league_board(text) to authenticated;
grant execute on function fn_league_give_kudos(uuid) to authenticated;

commit;
