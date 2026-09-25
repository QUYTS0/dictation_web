-- =====================================================
-- Phase 2 — small additive correction: word_match_request_seq
--
-- Inspected before implementing fn_persist_word_match_result (migration
-- 035), per the Phase 2 task's explicit instruction: shadowing_attempts
-- (migration 025) has azure_eval_request_seq for Azure's stale-response
-- protection (§9.4 — a response is only applied WHERE
-- azure_eval_request_seq = :seqAtRequestTime), but NO equivalent sequence
-- for Word Match. Without one, fn_persist_word_match_result would have to
-- either (a) reuse azure_eval_request_seq, incorrectly coupling Word
-- Match's freshness to an unrelated Azure evaluation request, or (b) apply
-- every Word Match result unconditionally, with no protection against an
-- out-of-order/stale response overwriting a newer one. Neither is
-- implementable per this plan's own "older responses cannot overwrite
-- newer results" requirement — this column is the minimal fix, mirroring
-- azure_eval_request_seq's exact shape and semantics, independently
-- incremented per Word Match evaluation trigger.
--
-- .claude/video-learning-management-plan.md is updated alongside this
-- migration (§8.7's shadowing_attempts DDL, §9.4/§9.9's Word Match
-- persistence description) to document this column.
-- =====================================================

alter table shadowing_attempts
  add column if not exists word_match_request_seq integer not null default 0;

comment on column shadowing_attempts.word_match_request_seq is
  'Mirrors azure_eval_request_seq (migration 025) for Word Match specifically '
  '-- incremented on each Word Match evaluation trigger; fn_persist_word_match_result '
  '(migration 035) only applies a result WHERE word_match_request_seq = :seqAtRequestTime, '
  'so a stale Word Match response can never overwrite a newer one, independently of '
  'Azure''s own sequence.';
