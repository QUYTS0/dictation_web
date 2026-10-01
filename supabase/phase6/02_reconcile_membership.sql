-- Phase 6 — one-time Library membership reconciliation. Run as `postgres`
-- AFTER the Phase 6 app is deployed (so no new gap can open behind it).
--
-- Adds a user_videos row for every (user, video) with REAL activity — a
-- practice round, Listening progress, a study session or a Shadowing take —
-- that has no membership and was never removed by the user. added_at is the
-- earliest such activity. Existing rows are never changed; removed videos are
-- never resurrected (user_video_removals) — removal markers are only cleared
-- by the user's explicit Add. While the reconciliation runs it holds a
-- SHARE ROW EXCLUSIVE lock on user_videos and user_video_removals, so app
-- membership writes wait for it (a second or two) instead of racing it.
-- Idempotent: a re-run adds nothing new unless new gaps appeared. The app
-- never does this on a Library read.
--
-- gap_before may be 0 (nothing to do). gap_after = 0 means no ELIGIBLE
-- missing membership remains; videos the user removed are excluded from
-- both counts and are reported as skippedRemoved.

select fn_phase6_membership_gap() as gap_before;
select fn_phase6_reconcile_membership() as result;   -- {"inserted": N, "skippedRemoved": M}
select fn_phase6_membership_gap() as gap_after;       -- expect 0 (removed videos excluded)
