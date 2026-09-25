-- =====================================================
-- Minimal Supabase platform shim for a DISPOSABLE vanilla PostgreSQL
-- database — used only by scripts/localdb/*.mjs and the real-Postgres
-- integration suites when a full `supabase start` stack is unavailable.
--
-- It reproduces exactly the platform pieces this project's migrations and
-- RPCs depend on, and nothing else:
--   * roles anon / authenticated / service_role (service_role BYPASSRLS),
--     like Supabase's; tests switch identity with `SET LOCAL ROLE` +
--     `request.jwt.claims`, which is precisely what PostgREST does per
--     request;
--   * auth.users (only the columns the 001 trigger reads), auth.uid(),
--     auth.role(), auth.jwt() — reading the same GUCs Supabase's do;
--   * Supabase's default privileges in `public` (every new table/function/
--     sequence is granted to anon, authenticated and service_role
--     individually) — which is what made 031/036 necessary, so it must be
--     reproduced for privilege tests to mean anything;
--   * storage.buckets / storage.objects stubs (018/019 only insert a
--     bucket row and create policies on objects).
--
-- NOT reproduced: PostgREST/GoTrue/HTTP behavior. Anything asserted through
-- this shim is a real-PostgreSQL result for SQL semantics (functions, locks,
-- RLS, GRANTs, transactions), not a Supabase-API result.
-- Never run against a real Supabase project (it already has all of this).
-- =====================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'authenticator';
  end if;
end;
$$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true), auth.jwt() ->> 'sub'), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.role', true), auth.jwt() ->> 'role'), '')
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text
);
alter table storage.objects enable row level security;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
