-- =====================================================
-- Phase 1 — activity_flush_log
--
-- Retry-safe batch identity for the additive Listening/activity counters
-- (§6.3b): every flush carries a client-generated flush_batch_id, and the
-- server inserts a (study_session_id, flush_batch_id) row here BEFORE
-- merging any interval data -- only a genuine first insert (not a
-- conflict) proceeds to apply the flush's effects, so a retried network
-- call is a full no-op beyond returning the already-current state.
--
-- See .claude/video-learning-management-plan.md §8.10 / Phase 1.
-- =====================================================

create table if not exists activity_flush_log (
  study_session_id uuid not null references study_sessions(id) on delete cascade,
  flush_batch_id uuid not null,
  kind text not null check (kind in ('listening', 'activity')),
  payload_fingerprint text not null,
  processed_at timestamptz not null default now(),
  primary key (study_session_id, flush_batch_id)
);

comment on table activity_flush_log is
  'Idempotency ledger for Listening/activity flushes -- an internal '
  'integrity record, not application data. Not wired into any route yet '
  '(Phase 1 is schema-only). See '
  '.claude/video-learning-management-plan.md §6.3b/§8.10.';
comment on column activity_flush_log.payload_fingerprint is
  'A hash of the flush''s interval payload, checked by fn_flush_study_'
  'activity (Phase 2) to reject a client that reuses a flush_batch_id with '
  'a materially different payload, rather than silently treating it as the '
  'original request.';

alter table activity_flush_log enable row level security;
-- Owner may SELECT (debugging/support visibility only); INSERT/UPDATE/
-- DELETE are reachable only through fn_flush_study_activity (SECURITY
-- DEFINER, Phase 2) -- an internal dedup/integrity record must not be
-- freely writable by the client it exists to police, so no owner-write
-- policy is defined at all.
create policy "activity_flush_log_owner_select" on activity_flush_log for select using (
  auth.uid() = (select user_id from study_sessions where id = study_session_id)
);

-- Explicit privileges (§4/§9.9 -- see 023_study_sessions.sql's comment for
-- the full old-vs-new-default-grants rationale). Read-only for
-- authenticated owners; no service_role grant added since no documented
-- write path in this plan uses the service-role client against this table
-- directly (writes go through a SECURITY DEFINER function, which needs no
-- grant of its own).
revoke all on activity_flush_log from public, anon, authenticated;
grant select on activity_flush_log to authenticated;
