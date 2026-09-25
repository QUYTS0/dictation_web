-- Phase 3 — STEP 6: retire legacy writes permanently, grant the authoritative
-- functions, and reopen — one transaction.
-- PRECONDITIONS:
--   * stage = 'backfilled';
--   * EVERY serving instance runs the PHASE 3 release (PRACTICE_WRITE_PATH
--     unset or 'authoritative') — confirmed in the deployment platform (step 5).
--     This transaction cannot see your deployment; running it with old
--     instances still serving means those instances start failing saves.
-- A legacy call already queued behind this transaction is refused after it
-- commits (legacy_writes_retired is checked inside the bridge's own gate read).
set lock_timeout = '15s';
set statement_timeout = '60s';
select fn_phase3_activate() as status;
reset lock_timeout;
reset statement_timeout;
