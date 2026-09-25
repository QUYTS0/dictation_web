-- Phase 3 — STEP 2: close direct writes to learning_sessions.
-- PRECONDITIONS (runbook §4 step 1, verified by YOU, not checkable here):
--   * every serving instance runs the PREPARATION release
--     (PRACTICE_WRITE_PATH=legacy), i.e. explain-all persists through
--     fn_persist_session_assessment and the three writers use the Phase 2 bridges;
--   * 00_preflight.sql looks as expected.
-- Waits at most 5s for in-flight direct statements (ACCESS EXCLUSIVE on the
-- table while policies change), then fails and changes nothing. Idempotent.
set lock_timeout = '5s';
set statement_timeout = '60s';
select fn_phase3_restrict_direct_writes() as status;
reset lock_timeout;
reset statement_timeout;
