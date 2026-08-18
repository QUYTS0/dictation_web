-- Drop the vestigial duplicate columns added by 002_auth_features.sql's
-- backfill. current_segment_index/total_attempts are the canonical, live
-- columns (used by the shared LearningSession type and dashboard/summary);
-- active_segment_index/attempt_count were only ever read as a redundant
-- fallback-preferred value in session/resume, with no trigger keeping them
-- in sync with the canonical pair going forward.

alter table if exists learning_sessions
  drop column if exists active_segment_index,
  drop column if exists attempt_count;
