-- =====================================================
-- Phase 2 — Corrective privilege migration
--
-- Postflight verification of Phase 1 (migrations 022-030) found that
-- effective TABLE-LEVEL privileges on three objects did not match the
-- intended design, even though RLS itself was correctly configured (RLS
-- and GRANT are two independent, both-required layers — a missing/broad
-- GRANT does not by itself prove a row is readable/writable, and RLS
-- blocking a command does not mean the underlying privilege is actually
-- absent). Root cause: Phase 1's migrations only ever ISSUED additive
-- GRANTs (or, for attempt_logs, deliberately left the pre-existing table's
-- grants untouched, reasoning RLS alone was sufficient) — they never
-- verified, for `service_role` specifically, that no broader
-- automatically-inherited privilege coexisted alongside what was
-- explicitly granted. This migration corrects exactly the three affected
-- objects, narrowly, with explicit object-scoped REVOKE/GRANT.
--
-- Confirmed observed state (from the user's own postflight query) before
-- this migration:
--   attempt_logs:                          anon=CRUD, authenticated=CRUD, service_role=CRUD
--   app_write_gate:                        service_role=CRUD (anon/authenticated already none)
--   migration_030_abandoned_rounds_log:    service_role=CRUD (anon/authenticated already none)
--
-- Target state (this migration):
--   attempt_logs:            anon=none; authenticated=SELECT only (still filtered by
--                             attempt_logs_owner_select); service_role=SELECT+INSERT only
--                             (exactly what dictation/check/route.ts's service-role insert
--                             and every SELECT-only reader actually use today — verified by
--                             grep, no route UPDATEs/DELETEs attempt_logs anywhere)
--   app_write_gate:           anon=none; authenticated=none; service_role=SELECT+UPDATE only
--   migration_030_abandoned_rounds_log:  anon=none; authenticated=none; service_role=SELECT only
--
-- Dependency check performed before restricting service_role, per the task's explicit
-- instruction: migration-owner operations (CREATE TABLE, the reconciliation INSERT/UPDATE
-- in migration 030 itself) run as the migration-applying role (the table owner, effectively
-- `postgres`/a superuser-equivalent role in Supabase-managed Postgres), which always retains
-- implicit owner privileges on objects it owns regardless of any REVOKE targeting
-- anon/authenticated/service_role — trimming service_role's grants here does NOT affect the
-- migration-owner's own ability to write the audit log, now or in any future migration.
-- service_role cascade-deletes of attempt_logs rows (e.g. via `DELETE FROM learning_sessions`
-- in test cleanup) are also unaffected: FK ON DELETE CASCADE is enforced by a constraint
-- trigger owned by the table owner, not gated by the deleting session's own privileges on the
-- child table.
-- =====================================================

-- ---------------------------------------------------------------
-- attempt_logs
-- ---------------------------------------------------------------

-- Full reset first (table-level ALL, which covers SELECT/INSERT/UPDATE/
-- DELETE/TRUNCATE/REFERENCES/TRIGGER in one statement — explicitly
-- including TRUNCATE, which the four-CRUD-flag view of "privileges" would
-- otherwise miss) for every role this migration is correcting, then
-- re-grant exactly what's intended. No column-level GRANT has ever been
-- issued anywhere in this repository's migration history (verified by
-- grep across supabase/migrations/*.sql for "grant" statements naming
-- column lists) — there is no column-privilege remnant to separately
-- revoke here; the postflight query in PHASE2_RUNBOOK.md re-checks this
-- rather than assuming it.
revoke all privileges on attempt_logs from anon, authenticated, service_role;

-- anon: none, full stop — an unauthenticated caller has no business with
-- Dictation attempt history at all.
-- (no grant follows for anon)

-- authenticated: SELECT only, still filtered by the existing
-- attempt_logs_owner_select policy (unchanged by this migration) — a
-- signed-in user can read their own attempt history and nothing else, and
-- cannot INSERT/UPDATE/DELETE at the privilege layer even before RLS is
-- considered.
grant select on attempt_logs to authenticated;

-- service_role: SELECT + INSERT only — exactly what today's actual
-- backend writer (dictation/check/route.ts's service-role .insert()) and
-- every service-role SELECT reader use. No route or script anywhere in
-- this codebase UPDATEs or DELETEs attempt_logs directly (verified by
-- grep); UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER are deliberately not
-- re-granted.
grant select, insert on attempt_logs to service_role;

-- ---------------------------------------------------------------
-- app_write_gate
-- ---------------------------------------------------------------

revoke all privileges on app_write_gate from anon, authenticated, service_role;
-- anon/authenticated: none (unchanged from Phase 1's intent — re-issued
-- here only as a defensive, explicit reset, not because Phase 1 actually
-- left them with anything per the observed postflight data).
grant select, update on app_write_gate to service_role;
-- No insert/delete for service_role: the singleton row (id=1) already
-- exists from migration 029 and must never be duplicated or removed by
-- any application-reachable role.

-- ---------------------------------------------------------------
-- migration_030_abandoned_rounds_log
-- ---------------------------------------------------------------

revoke all privileges on migration_030_abandoned_rounds_log from anon, authenticated, service_role;
grant select on migration_030_abandoned_rounds_log to service_role;
-- Read-only for service_role (operator/support visibility) — this table
-- is an immutable, one-time audit record; no application role, including
-- service_role, ever needs to write it again after migration 030 applied.
