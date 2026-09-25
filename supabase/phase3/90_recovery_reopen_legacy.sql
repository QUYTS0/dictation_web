-- Phase 3 — RECOVERY (only BEFORE activation): return to legacy operation.
-- Use when the cutover must be postponed after step 3 or step 4.
-- PRECONDITIONS:
--   * stage is 'paused' or 'backfilled' (refused otherwise, incl. after activation);
--   * every serving instance runs the PREPARATION release
--     (PRACTICE_WRITE_PATH=legacy). If you already deployed the Phase 3
--     release in step 5, roll the deployment back to the preparation
--     release FIRST — the Phase 3 routes would keep answering 503.
-- Effect: gate reopens, stage returns to 'restricted'. Direct writes stay
-- closed (they are not needed by the bridges). Rows written by the bridges
-- from now on are 'current'; the next 03_close_gate.sql records a new
-- boundary and the next 04_backfill.sql classifies them as a new batch —
-- earlier batches and their captured originals are never touched again.
set lock_timeout = '15s';
select fn_phase3_reopen_legacy() as status;
reset lock_timeout;
