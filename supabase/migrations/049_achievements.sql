-- =====================================================
-- 049 — Achievements (badge tracks with Bronze → Diamond tiers)
-- =====================================================
--
-- Dashboard redesign, Phase 6 (.claude/dashboard-redesign-plan.md §3.4,
-- decision D2).
--
--   achievement_tiers      — the ONE source of thresholds, seeded here; the
--                            app holds only names, icons and copy
--   user_achievements      — the tiers a learner unlocked, with the time it
--                            was first seen met. Readable by its owner; NO
--                            client write path (RLS + privileges)
--   fn_longest_streak      — longest run of consecutive dates
--   fn_streak_from_days    — SQL port of computeStreakFromDays
--                            (src/lib/utils/streak.ts), parity-tested
--   fn_sync_achievements   — recomputes every metric server-side, records
--                            newly met tiers, returns all tracks and the
--                            newly unlocked tiers. Takes no client values.
--
-- Metrics (each the Dashboard's own canonical number, never re-derived):
--   flame_keeper      longest streak ever, in days — fn_activity_days (all
--                     modes, word reviews included; its 400-day window)
--   precision_typist  correct latest Dictation answers (sentenceAccuracy.correct)
--   shadow_master     Azure-scored Shadowing sentences (shadowing.azure.evaluatedSentences)
--   lexicon           saved vocabulary items
--   immersion         active practice, in hours (activeTime.activeSec / 3600)
--   league            highest league tier reached — Phase 7 seeds its tiers
--
-- A tier stays unlocked once earned, even if its count later drops (e.g.
-- deleted words). Badges award no XP. Apply after 048; re-runnable.
-- =====================================================

begin;

-- -------------------------------------------------------------------------
-- 1. Tiers and unlocks
-- -------------------------------------------------------------------------

create table if not exists achievement_tiers (
  track text not null
    check (track in ('flame_keeper', 'precision_typist', 'shadow_master', 'lexicon', 'immersion', 'league')),
  tier smallint not null check (tier between 1 and 4), -- 1 Bronze, 2 Silver, 3 Gold, 4 Diamond
  threshold numeric not null check (threshold > 0),
  primary key (track, tier)
);

insert into achievement_tiers (track, tier, threshold) values
  ('flame_keeper', 1, 3), ('flame_keeper', 2, 7), ('flame_keeper', 3, 14), ('flame_keeper', 4, 30),
  ('precision_typist', 1, 25), ('precision_typist', 2, 100), ('precision_typist', 3, 250), ('precision_typist', 4, 500),
  ('shadow_master', 1, 10), ('shadow_master', 2, 50), ('shadow_master', 3, 150), ('shadow_master', 4, 400),
  ('lexicon', 1, 25), ('lexicon', 2, 100), ('lexicon', 3, 250), ('lexicon', 4, 500),
  ('immersion', 1, 1), ('immersion', 2, 5), ('immersion', 3, 20), ('immersion', 4, 50)
on conflict (track, tier) do update set threshold = excluded.threshold;

alter table achievement_tiers enable row level security;
drop policy if exists achievement_tiers_read on achievement_tiers;
create policy achievement_tiers_read on achievement_tiers for select to authenticated using (true);
revoke all on achievement_tiers from public, anon, authenticated, service_role;
grant select on achievement_tiers to authenticated, service_role;

create table if not exists user_achievements (
  user_id uuid not null references users(id) on delete cascade,
  track text not null,
  tier smallint not null,
  -- When the tier was first SEEN met (a sync), not when the count crossed
  -- the threshold — a learner with history before 049 unlocks at first sync.
  unlocked_at timestamptz not null default now(),
  primary key (user_id, track, tier),
  foreign key (track, tier) references achievement_tiers (track, tier)
);

alter table user_achievements enable row level security;
drop policy if exists user_achievements_owner_read on user_achievements;
create policy user_achievements_owner_read on user_achievements for select to authenticated using (user_id = auth.uid());
revoke all on user_achievements from public, anon, authenticated, service_role;
grant select on user_achievements to authenticated, service_role;

-- -------------------------------------------------------------------------
-- 2. Streak helpers (SQL ports of src/lib/utils/streak.ts)
-- -------------------------------------------------------------------------

-- The longest run of consecutive calendar dates (duplicates count once).
create or replace function fn_longest_streak(p_days date[])
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(max(len), 0)::integer from (
    select count(*) as len
      from (select d, d - (row_number() over (order by d))::integer as grp
              from (select distinct unnest(p_days) as d) u
             where d is not null) x
     group by grp
  ) runs;
$$;

-- computeStreakFromDays: consecutive dates ending today, or yesterday when
-- today has none yet; 0 when the latest is two or more days ago.
create or replace function fn_streak_from_days(p_days date[], p_today date)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  with s as (select distinct unnest(p_days) as d),
  start as (select case when exists (select 1 from s where d = p_today) then p_today else p_today - 1 end as st)
  select count(*)::integer
    from (select s.d, (select st from start) - s.d as off, row_number() over (order by s.d desc) - 1 as rn
            from s where s.d <= (select st from start)) t
   where off = rn;
$$;

revoke all on function fn_longest_streak(date[]) from public, anon, authenticated, service_role;
revoke all on function fn_streak_from_days(date[], date) from public, anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- 3. Sync
-- -------------------------------------------------------------------------

-- Returns { tracks: [{ track, value, tiers: [{ tier, threshold, unlockedAt|null }] }],
--           newlyUnlocked: [{ track, tier, unlockedAt }] }
-- tracks in a fixed order; only tracks with seeded tiers. newlyUnlocked
-- lists what THIS call recorded — a concurrent call that lost the race
-- reports nothing, so an unlock is announced once.
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
    'immersion', round(coalesce((fn_activity_union(v_user, null, null)->>'activeSec')::numeric, 0) / 3600, 2)
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

revoke all on function fn_sync_achievements() from public, anon, authenticated, service_role;
grant execute on function fn_sync_achievements() to authenticated;

commit;
