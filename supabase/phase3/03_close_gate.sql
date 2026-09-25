-- Phase 3 — STEP 3: pause and drain legacy writes. Maintenance starts here:
-- saves / restarts / recorded answers get a retryable 503 until step 6.
-- PRECONDITION: stage = 'restricted' (step 2 done).
-- Waits up to 15s for admitted bridge transactions to finish (they finish,
-- they are not aborted), then records the boundary with clock_timestamp().
-- If it times out it rolls back completely — just run it again.
-- Re-running while already paused keeps the recorded boundary.
set lock_timeout = '15s';
set statement_timeout = '60s';
select fn_phase3_close_gate() as status;
reset lock_timeout;
reset statement_timeout;
