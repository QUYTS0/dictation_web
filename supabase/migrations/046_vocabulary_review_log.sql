-- =====================================================
-- 046 — Vocabulary review log; vocabulary reviews count toward the streak
-- =====================================================
--
-- Dashboard redesign, Phase 3 (.claude/dashboard-redesign-plan.md §3.1,
-- decision D9). Until now POST /api/vocabulary/review only updated the
-- vocabulary item in place: no history was kept, and a day with only
-- vocabulary review earned no streak day.
--
--   vocabulary_reviews           — one append-only row per graded review
--   fn_record_vocabulary_review  — the item's SRS update + its log row, in
--                                  one transaction (the ONLY write path)
--   backfill                     — one row per already-reviewed item, at its
--                                  last_reviewed_at (older reviews were never
--                                  recorded and stay unknown)
--   fn_activity_days             — gains vocabulary reviews as a fourth day
--                                  source; same return shape, so /api/streak,
--                                  the Dashboard and the practice header keep
--                                  agreeing with no code change
--
-- Deploy order: apply this migration BEFORE deploying the app version whose
-- review route calls fn_record_vocabulary_review (until then that route
-- answers 503 "not available yet"; see supabase/DASHBOARD_REDESIGN_RUNBOOK.md).
-- Re-runnable: every statement is idempotent.
-- =====================================================

begin;

-- -------------------------------------------------------------------------
-- 1. The review log
-- -------------------------------------------------------------------------

create table if not exists vocabulary_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- Deleting a saved word keeps its review history: the day was still a
  -- day of practice. Deleting the account removes everything (user_id).
  item_id uuid null references vocabulary_items(id) on delete set null,
  -- Null only for backfilled rows: the grade of a past review was never stored.
  grade text null check (grade in ('again', 'hard', 'good', 'easy')),
  reviewed_at timestamptz not null default now(),
  -- A valid IANA zone captured from the browser at review time (validated on
  -- write), or null → the review's day is its UTC date (documented fallback,
  -- the same rule as activity batches without a zone).
  client_timezone text null,
  backfilled boolean not null default false,
  constraint vocabulary_reviews_grade_unless_backfilled check (backfilled or grade is not null)
);

create index if not exists vocabulary_reviews_user_reviewed_idx on vocabulary_reviews (user_id, reviewed_at desc);
create index if not exists vocabulary_reviews_item_idx on vocabulary_reviews (item_id);

comment on table vocabulary_reviews is
  'Dashboard redesign (046): one append-only row per graded vocabulary review. '
  'Written only by fn_record_vocabulary_review (and the one-time backfill). '
  'Feeds fn_activity_days (streak) and, later, XP. authenticated can SELECT '
  'its own rows (RLS); there is no insert/update/delete path for API roles.';

alter table vocabulary_reviews enable row level security;
drop policy if exists "vocabulary_reviews_owner_select" on vocabulary_reviews;
create policy "vocabulary_reviews_owner_select" on vocabulary_reviews
  for select using (auth.uid() = user_id);

-- Supabase's default privileges grant ALL on new tables to every API role.
revoke all on vocabulary_reviews from public, anon, authenticated, service_role;
grant select on vocabulary_reviews to authenticated, service_role;

-- -------------------------------------------------------------------------
-- 2. The one write path: SRS update + log row, atomically
-- -------------------------------------------------------------------------
--
-- The SRS values are computed by the route (computeNextReview,
-- src/lib/utils/srs.ts) exactly as before; this function only checks their
-- shape. The caller can already update its own vocabulary_items rows under
-- RLS, so accepting them grants no new capability. Returns the updated item
-- as jsonb, or null when the item doesn't exist or isn't the caller's.
create or replace function fn_record_vocabulary_review(
  p_item_id uuid,
  p_grade text,
  p_interval_days numeric,
  p_ease_factor numeric,
  p_repetitions integer,
  p_next_review_at timestamptz,
  p_time_zone text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_item vocabulary_items%rowtype;
  v_tz text := case when p_time_zone is not null and fn_valid_time_zone(p_time_zone) then p_time_zone else null end;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_item_id is null
     or p_grade is null or p_grade not in ('again', 'hard', 'good', 'easy')
     or p_interval_days is null or p_interval_days < 0
     or p_ease_factor is null or p_ease_factor < 1
     or p_repetitions is null or p_repetitions < 0
     or p_next_review_at is null then
    raise exception 'invalid_payload';
  end if;

  update vocabulary_items
     set interval_days = p_interval_days,
         ease_factor = p_ease_factor,
         repetitions = p_repetitions,
         next_review_at = p_next_review_at,
         last_reviewed_at = now()
   where id = p_item_id and user_id = v_user
  returning * into v_item;
  if not found then return null; end if;

  insert into vocabulary_reviews (user_id, item_id, grade, reviewed_at, client_timezone)
  values (v_user, p_item_id, p_grade, v_item.last_reviewed_at, v_tz);

  return to_jsonb(v_item);
end;
$$;

revoke all on function fn_record_vocabulary_review(uuid, text, numeric, numeric, integer, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function fn_record_vocabulary_review(uuid, text, numeric, numeric, integer, timestamptz, text)
  to authenticated;

-- -------------------------------------------------------------------------
-- 3. Backfill: the one review per item that is known
-- -------------------------------------------------------------------------
--
-- Only last_reviewed_at survives from before this migration, so each
-- reviewed item contributes exactly one backfilled row (grade unknown, UTC
-- day). Idempotent: an item that already has a backfilled row is skipped.
insert into vocabulary_reviews (user_id, item_id, grade, reviewed_at, client_timezone, backfilled)
select v.user_id, v.id, null, v.last_reviewed_at, null, true
  from vocabulary_items v
 where v.last_reviewed_at is not null
   and not exists (select 1 from vocabulary_reviews r where r.item_id = v.id and r.backfilled);

-- -------------------------------------------------------------------------
-- 4. fn_activity_days: vocabulary reviews are a practice day (D9)
-- -------------------------------------------------------------------------
--
-- Identical to 040 except for rule 4 (the `reviews` CTE). Day rules, in order:
--   1. Activity batches: the dates stored with the batch (local, or UTC when
--      it carried no valid timezone).
--   2. Study sessions with NO dated batch (before 040): UTC dates of their
--      activity intervals.
--   3. Dictation answers and Shadowing takes: local date in the timezone of
--      the nearest-in-time local batch of their own study session; UTC when
--      that session has none.
--   4. Vocabulary reviews: local date in the timezone captured with the
--      review; UTC when none (incl. every backfilled row).
-- Returns { days, utcFallbackDays } as before. CREATE OR REPLACE keeps the
-- existing owner and grants (execute: authenticated only, from 040).
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

commit;
