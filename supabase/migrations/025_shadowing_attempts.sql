-- =====================================================
-- Phase 1 — shadowing_attempts
--
-- Shadowing practice-credit and evaluation storage. Azure pronunciation
-- fields and Word Match fields are kept independent (never blended into a
-- single "score" at the schema level -- see the plan's §6.7 fallback-
-- removal correction). No stored recording/audio field of any kind, by
-- design (§14's "no long-term recording storage" policy is preserved
-- exactly as-is).
--
-- See .claude/video-learning-management-plan.md §8.7 / §9.9 / Phase 1.
-- =====================================================

create table if not exists shadowing_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  round_id uuid not null references learning_sessions(id) on delete cascade,
  study_session_id uuid null references study_sessions(id) on delete set null,
  youtube_video_id text not null,
  transcript_id uuid null references transcripts(id) on delete set null,
  segment_index integer not null,
  segment_id uuid null references transcript_segments(id) on delete set null,
  client_attempt_id uuid not null default gen_random_uuid(),
  recording_duration_sec numeric not null check (recording_duration_sec >= 0),
  is_practice_valid boolean not null,
  validity_basis text not null default 'client_reported'
    check (validity_basis in ('client_reported', 'server_verified')),
  word_match_status text null check (word_match_status in ('completed', 'failed', 'unsupported')),
  word_match_accuracy numeric null,
  word_match_completeness numeric null,
  azure_eval_status text not null default 'not_evaluated'
    check (azure_eval_status in ('not_evaluated', 'pending', 'completed', 'failed')),
  azure_eval_request_seq integer not null default 0,
  eval_requested_at timestamptz null,
  azure_accuracy_score numeric null,
  azure_fluency_score numeric null,
  azure_completeness_score numeric null,
  azure_prosody_score numeric null,
  azure_pronunciation_score numeric null,
  azure_error_reason text null,
  engine_version text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists shadowing_attempts_idempotency_idx
  on shadowing_attempts(round_id, segment_index, client_attempt_id);
create index if not exists shadowing_attempts_round_segment_idx
  on shadowing_attempts(round_id, segment_index, created_at desc);

comment on table shadowing_attempts is
  'Shadowing practice attempts and their (independent) Azure/Word Match '
  'evaluation results. validity_basis=''client_reported'' is an honest '
  'acknowledgment that the practice-credit endpoint (Phase 4+) receives '
  'only a duration number, not audio, so it cannot itself verify real '
  'speech occurred -- kept entirely separate from is_practice_valid. Not '
  'wired into any route/UI yet (Phase 1 is schema-only).';
comment on column shadowing_attempts.azure_eval_request_seq is
  'Incremented on each evaluation trigger (Phase 4+); a provider-result '
  'write is only applied WHERE azure_eval_request_seq = :seqAtRequestTime, '
  'so a stale/older async response can never overwrite a newer one.';

alter table shadowing_attempts enable row level security;

-- Owner may SELECT freely. No owner insert/update/delete policy at all --
-- a client-writable INSERT, even one restricted to a "fresh, unevaluated"
-- row shape, would still bypass the round lock, the idempotency-key
-- validation, and the stale-revision check that only exist inside
-- fn_record_shadowing_attempt (Phase 2). All writes -- INSERT of a fresh
-- practiced row, and UPDATE of provider-issued columns -- go through
-- SECURITY DEFINER functions, which bypass RLS as the table owner (§9.9)
-- and need no policy here to do so. The service-role policy below is kept
-- as an independent, standalone allowance for direct administrative/
-- support access with the service-role key, not because any function
-- needs it.
create policy "shadowing_attempts_owner_select" on shadowing_attempts
  for select using (auth.uid() = user_id);
create policy "shadowing_attempts_service_write" on shadowing_attempts
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Explicit privileges (§4/§9.9 -- see 023_study_sessions.sql's comment for
-- the full old-vs-new-default-grants rationale, applied identically here).
revoke all on shadowing_attempts from public, anon, authenticated;
grant select on shadowing_attempts to authenticated;
-- service_role: full CRUD, matching the explicit service-write RLS policy
-- above -- a policy alone does not supply the underlying table privilege,
-- so both are declared together (§4's "keep GRANTs and RLS consistent").
grant select, insert, update, delete on shadowing_attempts to service_role;
