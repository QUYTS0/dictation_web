-- =====================================================
-- Phase 1 — users.is_admin, transcript size-estimate columns, app_write_gate
--
-- Three independent additions, batched into one migration per the plan's
-- "all new schema in one early phase" ordering fix:
--   1. users.is_admin, protected against client self-grant.
--   2. transcripts size-estimate columns (unused until a later phase's
--      Script Versions feature; added now so no later phase needs to
--      widen a table another phase already depends on).
--   3. app_write_gate: an unpaused singleton row for the Phase 3 cutover
--      runbook. Existing routes do not consult it yet -- creating it here
--      does NOT make it an active write fence; it only becomes one once a
--      later phase's writers are changed to check it.
--
-- See .claude/video-learning-management-plan.md §8.11 / §9.9 / Phase 1.
-- =====================================================

-- ---------------------------------------------------------------
-- 1. users.is_admin
-- ---------------------------------------------------------------

alter table users add column if not exists is_admin boolean not null default false;

comment on column users.is_admin is
  'Protected by the users_prevent_self_admin_grant trigger below -- a '
  'direct PostgREST PATCH from a signed-in user succeeds (the existing '
  'users_self_update policy still permits the row UPDATE) but silently has '
  'no effect on this column. The only way to actually change it is a '
  'trusted, out-of-band service-role operation (e.g. the Supabase SQL '
  'editor or a service-role script) -- this migration does not promote any '
  'real user.';

-- Blocks a client from granting themselves admin via a direct PostgREST
-- PATCH. The existing users_self_update policy (001_initial.sql:153, `for
-- update using (auth.uid() = id)`) has no `with check`, so without this
-- trigger a user could set is_admin=true on their own row. RLS still
-- permits the row update; the trigger just makes this one column inert
-- for a non-service-role actor.
--
-- Reconciles the plan's two differing trigger-function declarations
-- (§8.11 plain `language plpgsql`; §9.9 `security definer set
-- search_path = ...`) into one tested implementation: SECURITY INVOKER
-- (the default -- no `security definer` keyword), since the function only
-- reads NEW/OLD (already visible to the invoking UPDATE statement) and
-- calls auth.role() (callable by any role) -- no elevated privilege is
-- actually needed, so none is granted. search_path is still pinned, as a
-- general hygiene measure independent of SECURITY DEFINER, matching the
-- discipline this plan applies to every other function it defines.
--
-- Handles missing/null role information explicitly, not with a fail-open
-- comparison: `auth.role()` returns the JWT's role claim as text, or NULL
-- for a connection with no JWT at all (never observed for a request that
-- reaches this trigger via PostgREST, but handled defensively regardless).
-- `NULL <> 'service_role'` evaluates to NULL, which is NOT TRUE in a
-- plpgsql `if` condition -- so a null/missing role identity takes the
-- SAME branch as an ordinary non-service-role client (the is_admin
-- overwrite fires, silently discarding any client-attempted change) rather
-- than the reverse. This is fail-closed with respect to the protected
-- column, not fail-open.
create or replace function prevent_self_admin_grant()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$;

drop trigger if exists users_prevent_self_admin_grant on users;
create trigger users_prevent_self_admin_grant
  before update on users for each row execute function prevent_self_admin_grant();

-- ---------------------------------------------------------------
-- 2. transcripts size-estimate columns (unused until a later phase)
-- ---------------------------------------------------------------

alter table transcripts
  add column if not exists estimated_text_bytes bigint null,
  add column if not exists estimated_segments_bytes bigint null,
  add column if not exists estimated_translations_bytes bigint null,
  add column if not exists estimated_highlights_bytes bigint null,
  add column if not exists estimated_total_bytes bigint null,
  add column if not exists size_estimated_at timestamptz null;

comment on column transcripts.estimated_total_bytes is
  'Unused until the Script Versions feature (a later phase) actually '
  'computes it. Null/unknown for every row -- this migration does not '
  'calculate or guess a size estimate for any existing transcript.';

-- ---------------------------------------------------------------
-- 3. app_write_gate (created unpaused; not yet consulted by any writer)
-- ---------------------------------------------------------------

create table if not exists app_write_gate (
  id integer primary key default 1 check (id = 1),
  completion_writes_paused boolean not null default false,
  paused_at timestamptz null
);

comment on table app_write_gate is
  'Singleton write-gate row for the Phase 3 cutover runbook. Created here '
  'in its unpaused state (completion_writes_paused = false) as part of '
  'this phase''s "all new schema in one batch" ordering fix. No existing '
  'route consults this table yet -- it is NOT an active write fence until '
  'a later phase''s writers are changed to check it.';

insert into app_write_gate (id, completion_writes_paused)
values (1, false)
on conflict (id) do nothing;

alter table app_write_gate enable row level security;
-- Zero permissive policies for authenticated/anon -- a client cannot read
-- or write this table through any Supabase client call at all, under
-- either grant-defaults regime (the REVOKE below removes the table
-- privilege too, so this holds even if a permissive policy were ever
-- added by mistake in a future migration).
revoke all on app_write_gate from public, anon, authenticated;
-- service_role: SELECT + UPDATE only, for the future cutover runbook
-- (which flips completion_writes_paused via a service-role script) --
-- never INSERT/DELETE, since the singleton row already exists and must
-- never be duplicated or removed.
grant select, update on app_write_gate to service_role;
