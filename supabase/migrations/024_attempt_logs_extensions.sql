-- =====================================================
-- Phase 1 — attempt_logs extensions
--
-- Adds study-session linkage, client-generated idempotency identity,
-- hint-usage tracking, practice validity, transcript/segment pin
-- references, and provenance -- then tightens the table's RLS from the
-- existing "attempts_owner" (`for all`, i.e. a direct client can INSERT/
-- UPDATE/DELETE any row it can reach) down to owner-SELECT-only.
--
-- Verified before writing this migration, by direct read of
-- src/app/api/dictation/check/route.ts: the only INSERT into attempt_logs
-- anywhere in this codebase already uses createServiceClient() (the
-- service-role client, which bypasses RLS entirely) -- not the
-- RLS-respecting `createClient()`. Tightening attempts_owner therefore
-- does NOT affect the current Dictation attempt writer; it closes a latent
-- gap where a browser client, authenticated with the user's own JWT, could
-- otherwise INSERT/UPDATE/DELETE attempt_logs rows directly via PostgREST
-- with none of the round-lock/idempotency/relationship checks the
-- application's own write path applies.
--
-- See .claude/video-learning-management-plan.md §8.6 / §9.9 / Phase 1.
-- =====================================================

alter table attempt_logs
  add column if not exists study_session_id uuid null references study_sessions(id) on delete set null,
  add column if not exists client_attempt_id uuid not null default gen_random_uuid(),
  add column if not exists hint_level_used smallint null,
  add column if not exists is_practice_valid boolean not null default true,
  add column if not exists transcript_id uuid null references transcripts(id) on delete set null,
  add column if not exists segment_id uuid null references transcript_segments(id) on delete set null,
  add column if not exists segment_identity_provenance text not null default 'verified'
    check (segment_identity_provenance in ('verified', 'legacy_unverified'));

comment on column attempt_logs.client_attempt_id is
  'Client-generated idempotency key, unique per (session_id, segment_index, '
  'client_attempt_id) -- see attempt_logs_idempotency_idx below. Every '
  'pre-existing row received its own distinct value via this column''s '
  'volatile default at migration time (one gen_random_uuid() call per row), '
  'not a shared placeholder, so the new unique index below is satisfiable '
  'immediately even where a session/segment_index pair already has '
  'multiple historical rows.';
comment on column attempt_logs.hint_level_used is
  'Nullable with NO default (deliberately not `not null default 0`) -- '
  'NULL means genuinely unknown. Only rows written after the client '
  'actually starts reporting a hint level (Phase 3+) ever have a non-null '
  'value; a pre-existing row is never assumed to mean "no hint used".';
comment on column attempt_logs.segment_identity_provenance is
  'Schema default ''verified'' in this migration for every row, new and '
  'pre-existing. The retroactive ''legacy_unverified'' tagging of '
  'pre-existing rows (whose transcript_id/segment_id, once backfilled, '
  'cannot be verified against the pre-Phase-0 destructive-regeneration '
  'history) happens in migration 034, alongside the '
  'learning_sessions.provenance backfill -- not part of Phase 1.';

-- Idempotency: a genuine retry of the same client-generated attempt (same
-- session, same segment, same client_attempt_id) must resolve to the same
-- row rather than inserting a duplicate. Satisfiable against existing data
-- because every existing row already has a distinct client_attempt_id
-- (comment above).
create unique index if not exists attempt_logs_idempotency_idx
  on attempt_logs(session_id, segment_index, client_attempt_id);

create index if not exists attempt_logs_round_segment_idx
  on attempt_logs(session_id, segment_index, created_at desc);

-- Tighten the EXISTING attempts_owner policy (001_initial.sql:160-161,
-- `for all using (auth.uid() = ...)`), which today permits a direct client
-- INSERT/UPDATE/DELETE via PostgREST -- confirmed reachable, since this
-- app's browser client (src/lib/supabase/client.ts) authenticates with the
-- user's own JWT, not just the service role. Left as-is, it would bypass
-- every round-lock/idempotency/relationship-validation guarantee the later
-- phases of this plan add. attempt_logs was never designed to be writable
-- outside its one existing call site (verified above), so this closes a
-- latent gap in the existing table, not just a new one.
drop policy if exists "attempts_owner" on attempt_logs;
create policy "attempt_logs_owner_select" on attempt_logs for select using (
  session_id in (select id from learning_sessions where user_id = auth.uid())
);
-- No owner insert/update/delete policy. The one legitimate write path
-- (dictation/check/route.ts) already uses the service-role client, which
-- bypasses RLS entirely and is therefore unaffected by this policy change;
-- from Phase 2 onward, writes are additionally reachable through
-- fn_record_dictation_attempt (SECURITY DEFINER), which performs its own
-- explicit auth.uid()-based checks in the function body rather than
-- relying on this table's RLS at all.

-- attempt_logs already carries whatever table-level GRANTs it received
-- when 001_initial.sql first created it (this is a pre-existing table, not
-- a new Phase 1 object) -- no GRANT/REVOKE change is made here. The
-- service-role client used by dictation/check/route.ts needs no RLS policy
-- or GRANT change either: the service role already had (and keeps) the
-- privileges it was using before this migration.
