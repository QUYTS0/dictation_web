-- Phase 3 — STEP 4: bounded, audited legacy backfill (one transaction).
-- PRECONDITION: stage = 'paused'. Refuses otherwise; refuses after activation.
-- Either commits completely (stage → 'backfilled') or leaves no trace.
-- Re-running after success is a no-op that returns the stored summary.
set lock_timeout = '15s';
set statement_timeout = '10min';
select fn_phase3_backfill() as status;
reset lock_timeout;
reset statement_timeout;

-- Review the result (read-only):
select backfill_summary from phase3_cutover_state;
select count(*) filter (where provenance = 'current') as current_rounds_left  -- must be 0
from learning_sessions;
select count(*) filter (where segment_identity_provenance = 'verified') as verified_attempts_left  -- must be 0
from attempt_logs;
select anomalies, count(*) from phase3_backfill_rounds where array_length(anomalies, 1) > 0 group by 1 order by 2 desc;
select identity_resolution, count(*) from phase3_backfill_attempts group by 1 order by 2 desc;
