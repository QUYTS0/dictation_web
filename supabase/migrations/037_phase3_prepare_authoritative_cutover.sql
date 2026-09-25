-- =====================================================
-- 037 — Phase 3 PREPARATION (safe under ordinary `supabase db push`)
--
-- Installs everything the Phase 3 cutover needs, and ACTIVATES NOTHING:
--   * after this migration, the three Phase 2 legacy bridges keep serving
--     save-progress / session/restart / dictation/check exactly as before;
--   * the authoritative round/attempt functions are (re)created DORMANT —
--     EXECUTE revoked from PUBLIC/anon/authenticated/service_role — and in
--     addition refuse to write until app_write_gate.authoritative_writes_active
--     is true, which only fn_phase3_activate() sets;
--   * learning_sessions' permissive RLS/GRANTs are untouched here;
--   * no row of learning_sessions / attempt_logs is modified.
--
-- Every state-changing cutover step is an explicit, owner-only function the
-- operator calls in the order given by supabase/PHASE3_RUNBOOK.md:
--   fn_phase3_restrict_direct_writes() → fn_phase3_close_gate() →
--   fn_phase3_backfill() → (deploy Phase 3 app) → fn_phase3_activate()
-- plus fn_phase3_reopen_legacy() (pre-activation recovery) and
-- fn_phase3_status() (read-only). None of them is callable by any
-- application role, and none runs as a side effect of this migration.
--
-- Also installs, for the PREPARATORY application release:
--   * fn_persist_session_assessment — backend-only replacement for
--     explain-all's direct `learning_sessions` UPDATE (granted to
--     service_role now, because the prep release must use it BEFORE
--     fn_phase3_restrict_direct_writes() removes the old path);
--   * fn_practice_write_status — lets Phase 3 routes tell "not activated /
--     paused (maintenance)" apart from a genuine permission problem.
--
-- Corrections to the Phase 2 dormant functions (never granted, so their
-- signatures can change safely; old signatures are DROPPED so no stale
-- overload can ever be granted by mistake):
--   * fn_normalize_dictation_text: exact parity with src/lib/utils/text.ts
--     normalizeText() — JS `trim()`/`\s` Unicode whitespace set, JS step
--     order (special chars → trim → NFC → collapse). The 032 version used
--     btrim() (ASCII space only) and locale-dependent `\s`, so e.g. an NBSP
--     between words produced "helloworld" in SQL vs "hello world" in TS.
--   * fn_classify_dictation_error: SQL port of classifyError() so the stored
--     error_type is computed server-side, not trusted from the caller.
--   * coverage/completion count only ELIGIBLE sentences (text_normalized
--     <> ''), the same rule as required_sentence_count.
--   * fn_create_or_get_active_round validates the client's transcript
--     against the resolved/new round atomically and can apply the first
--     checkpoint in the same transaction (no create-then-reject).
--   * fn_update_resume_position validates video + transcript pin and never
--     touches a non-active round.
--   * fn_restart_round is retry-safe (expected round id) and resolves the
--     transcript BEFORE abandoning anything.
--   * fn_record_dictation_attempt: idempotency scoped to (round,
--     client_attempt_id) with the full immutable payload — including the
--     effective grading mode (new attempt_logs.match_mode) — compared; retry
--     returns the stored row with no side effects; whitespace-only answers
--     (JS whitespace set) are never practice-valid; server-assigned study
--     session attribution under one rule set for supplied and automatic
--     ids (fn_attribute_study_session); server-maintained total_attempts/accuracy
--     (same attempt-based meaning as the legacy client counters);
--     created_at = clock_timestamp() inside the round lock so "latest
--     attempt" order equals commit order.
--   * one lock order everywhere: gate (FOR SHARE) → advisory (user,video)
--     → round row (FOR UPDATE).
-- =====================================================

-- Grading parity needs the ICU root collation (see fn_classify_dictation_error).
do $$
begin
  if not exists (select 1 from pg_collation where collname = 'und-x-icu') then
    raise exception '037 requires the ICU collation "und-x-icu" (PostgreSQL built with ICU, as on Supabase)';
  end if;
end;
$$;

-- -------------------------------------------------------------------------
-- 1. Cutover state (durable, owner-only)
-- -------------------------------------------------------------------------

alter table app_write_gate
  add column if not exists legacy_writes_retired boolean not null default false,
  add column if not exists authoritative_writes_active boolean not null default false;

comment on column app_write_gate.legacy_writes_retired is
  'Phase 3: once true, every fn_legacy_* bridge refuses to write, checked '
  'inside the same FOR SHARE gate read the bridge already performs — so a '
  'legacy call queued behind the activation transaction observes it after '
  'that transaction commits. Permanent (see trigger below).';
comment on column app_write_gate.authoritative_writes_active is
  'Phase 3: authoritative round/attempt functions write only while this is '
  'true and completion_writes_paused is false. Set only by fn_phase3_activate().';

create or replace function app_write_gate_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.legacy_writes_retired and not new.legacy_writes_retired then
    raise exception 'legacy_writes_retired_is_permanent';
  end if;
  return new;
end;
$$;
revoke execute on function app_write_gate_guard() from public, anon, authenticated, service_role;
drop trigger if exists app_write_gate_guard on app_write_gate;
create trigger app_write_gate_guard before update on app_write_gate
  for each row execute function app_write_gate_guard();

-- service_role keeps exactly what 031 gave it for the Phase 2 fence columns,
-- but can no longer flip the Phase 3 activation/retirement flags.
revoke update on app_write_gate from service_role;
grant update (completion_writes_paused, paused_at) on app_write_gate to service_role;

create table if not exists phase3_cutover_state (
  id integer primary key default 1 check (id = 1),
  stage text not null default 'prepared'
    check (stage in ('prepared', 'restricted', 'paused', 'backfilled', 'activated')),
  direct_writes_restricted_at timestamptz null,
  cutover_at timestamptz null,
  backfill_completed_at timestamptz null,
  backfill_runs integer not null default 0,
  activated_at timestamptz null,
  backfill_summary jsonb null,
  updated_at timestamptz not null default now()
);
insert into phase3_cutover_state (id) values (1) on conflict (id) do nothing;
comment on table phase3_cutover_state is
  'Phase 3 cutover stage machine (singleton). Owner-only. cutover_at is the '
  'fence boundary captured with clock_timestamp() after the gate lock was '
  'acquired; a retried close keeps it. See supabase/PHASE3_RUNBOOK.md.';

create table if not exists phase3_cutover_log (
  id bigserial primary key,
  event text not null,
  detail jsonb not null default '{}'::jsonb,
  actor text not null default current_user,
  at timestamptz not null default clock_timestamp()
);

-- Original values of every round in the legacy cohort, captured BEFORE the
-- backfill changes anything. A row is never overwritten once captured.
create table if not exists phase3_backfill_rounds (
  round_id uuid primary key,
  user_id uuid null,
  youtube_video_id text not null,
  transcript_id uuid null,
  orig_status text not null,
  orig_provenance text not null,
  orig_round_number integer not null,
  orig_required_sentence_count integer null,
  orig_completed_at timestamptz null,
  orig_started_at timestamptz not null,
  orig_updated_at timestamptz not null,
  cutover_at timestamptz not null,
  batch integer not null,
  new_round_number integer null,
  new_required_sentence_count integer null,
  new_completed_at timestamptz null,
  completed_at_inferred boolean not null default false,
  anomalies text[] not null default '{}',
  captured_at timestamptz not null default clock_timestamp()
);

create table if not exists phase3_backfill_attempts (
  attempt_id uuid primary key,
  round_id uuid not null,
  orig_segment_identity_provenance text not null,
  orig_transcript_id uuid null,
  orig_segment_id uuid null,
  identity_resolution text not null
    check (identity_resolution in ('already_set', 'resolved_text_match', 'unresolved_no_round_pin',
                                   'unresolved_no_segment', 'unresolved_text_mismatch')),
  batch integer not null,
  captured_at timestamptz not null default clock_timestamp()
);
create index if not exists phase3_backfill_attempts_round_idx on phase3_backfill_attempts(round_id);

-- Supabase's default privileges grant every new public table to anon,
-- authenticated and service_role — none of these may be reachable by any
-- application role.
alter table phase3_cutover_state enable row level security;
alter table phase3_cutover_log enable row level security;
alter table phase3_backfill_rounds enable row level security;
alter table phase3_backfill_attempts enable row level security;
revoke all on phase3_cutover_state, phase3_cutover_log, phase3_backfill_rounds, phase3_backfill_attempts
  from public, anon, authenticated, service_role;
revoke all on sequence phase3_cutover_log_id_seq from public, anon, authenticated, service_role;

alter table learning_sessions
  add column if not exists completed_at_approximate boolean not null default false;

-- Idempotency backstops for the round-scoped key the authoritative
-- functions use (the Phase 1 indexes also include segment_index, which
-- would let one client_attempt_id be reused on another sentence). Every
-- existing row already has its own distinct client_attempt_id (024/025).
create unique index if not exists attempt_logs_round_client_attempt_idx
  on attempt_logs(session_id, client_attempt_id);
create unique index if not exists shadowing_attempts_round_client_attempt_idx
  on shadowing_attempts(round_id, client_attempt_id);
comment on column learning_sessions.completed_at_approximate is
  'True when completed_at was inferred by the Phase 3 legacy backfill from '
  'the row''s last update time (bounded by the cutover boundary) rather '
  'than recorded at the moment of completion.';

-- The effective grading mode is part of a Dictation attempt's immutable
-- request identity: the same text can be correct under 'relaxed' and wrong
-- under 'exact', so an idempotent retry must match it too. Nullable with no
-- default — a nullable column without a default is a catalog-only change
-- (no table rewrite, no row modified), and rows written before this column
-- existed (legacy bridge, backfill) keep NULL = "never recorded"; a mode is
-- never inferred for them.
alter table attempt_logs
  add column if not exists match_mode text null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'attempt_logs_match_mode_check') then
    alter table attempt_logs add constraint attempt_logs_match_mode_check
      check (match_mode is null or match_mode in ('exact', 'relaxed', 'learning'));
  end if;
end;
$$;
comment on column attempt_logs.match_mode is
  'Effective grading mode the attempt was graded with (Phase 3 authoritative '
  'writer only). NULL = not recorded (every pre-Phase-3 row); never inferred.';

-- -------------------------------------------------------------------------
-- 2. Gate helpers
-- -------------------------------------------------------------------------

-- Legacy bridges (fn_legacy_*) call this by name as their first statement;
-- replacing its body extends them with the permanent retirement check
-- without touching the bridges themselves. The retirement flag is read in
-- the SAME locking statement, so a bridge that waited for the activation
-- transaction's FOR UPDATE re-reads the committed row and is refused.
create or replace function fn_check_write_gate()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_gate record;
begin
  select completion_writes_paused, legacy_writes_retired into v_gate
    from app_write_gate where id = 1
    for share;
  if not found then
    raise exception 'write_gate_missing';
  end if;
  if v_gate.legacy_writes_retired then
    raise exception 'legacy_writes_retired';
  end if;
  if v_gate.completion_writes_paused then
    raise exception 'write_gate_paused';
  end if;
end;
$$;

create or replace function fn_check_authoritative_write_gate()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_gate record;
begin
  select completion_writes_paused, authoritative_writes_active into v_gate
    from app_write_gate where id = 1
    for share;
  if not found then
    raise exception 'write_gate_missing';
  end if;
  if v_gate.completion_writes_paused or not v_gate.authoritative_writes_active then
    raise exception 'write_gate_paused';
  end if;
end;
$$;

-- Minimal availability signal for the application (no cutover metadata).
create or replace function fn_practice_write_status()
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'available', coalesce(bool_and(not completion_writes_paused and authoritative_writes_active), false)
  )
  from app_write_gate where id = 1;
$$;

-- -------------------------------------------------------------------------
-- 3. Scoring: exact parity with src/lib/utils/text.ts
-- -------------------------------------------------------------------------

-- ECMAScript WhiteSpace + LineTerminator (what JS `\s` and String#trim()
-- match): TAB LF VT FF CR SPACE NBSP U+1680 U+2000–U+200A U+2028 U+2029
-- U+202F U+205F U+3000 U+FEFF. Explicit, so the result never depends on the
-- database's locale/ctype (Postgres's `\s` does).
create or replace function fn_js_whitespace_chars()
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
      || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
      || chr(8199) || chr(8200) || chr(8201) || chr(8202)
      || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279);
$$;

-- normalizeWhitespace(): trim() → normalize("NFC") → /\s+/g → " "
create or replace function fn_js_normalize_whitespace(p_text text)
returns text
language plpgsql
immutable
parallel safe
set search_path = public, pg_temp
as $$
declare
  v_ws text := fn_js_whitespace_chars();
  v text := coalesce(p_text, '');
begin
  v := regexp_replace(v, '^[' || v_ws || ']+|[' || v_ws || ']+$', '', 'g');
  v := normalize(v, NFC);
  v := regexp_replace(v, '[' || v_ws || ']+', ' ', 'g');
  return v;
end;
$$;

-- removePunctuation(): /[^\w\s']|_/g → "" then /'\s/g → " ". JS `\w`
-- without the u flag is ASCII-only.
create or replace function fn_js_remove_punctuation(p_text text)
returns text
language plpgsql
immutable
parallel safe
set search_path = public, pg_temp
as $$
declare
  v_ws text := fn_js_whitespace_chars();
  v text := coalesce(p_text, '');
begin
  v := regexp_replace(v, '[^A-Za-z0-9''' || v_ws || ']', '', 'g');
  v := regexp_replace(v, '''[' || v_ws || ']', ' ', 'g');
  return v;
end;
$$;

-- normalizeText(text, mode)
create or replace function fn_normalize_dictation_text(p_text text, p_mode text)
returns text
language plpgsql
immutable
parallel safe
set search_path = public, pg_temp
as $$
declare
  v text := coalesce(p_text, '');
begin
  -- normalizeSpecialChars, same order as the JS source
  v := regexp_replace(v, '[' || chr(8216) || chr(8217) || chr(96) || chr(180) || ']', '''', 'g');
  v := regexp_replace(v, '[' || chr(8220) || chr(8221) || ']', '"', 'g');
  v := regexp_replace(v, chr(8211) || '|' || chr(8212), '-', 'g');
  v := replace(v, chr(8230), '...');
  v := fn_js_normalize_whitespace(v);
  if p_mode in ('relaxed', 'learning') then
    -- After removePunctuation only ASCII letters/digits, apostrophes and
    -- whitespace remain, so an ASCII-only lower() is exactly JS
    -- toLowerCase() here.
    v := lower(fn_js_remove_punctuation(v) collate "C");
    v := fn_js_normalize_whitespace(v);
  end if;
  return v;
end;
$$;

-- classifyError(normalizedExpected, normalizedUser)
create or replace function fn_classify_dictation_error(p_expected text, p_user text)
returns text
language plpgsql
immutable
parallel safe
set search_path = public, pg_temp
as $$
declare
  v_ws text := fn_js_whitespace_chars();
  -- JS toLowerCase() is the locale-independent Unicode default case
  -- mapping; the ICU root collation reproduces it (incl. İ → i̇). The
  -- database's own collation (often "C") would lowercase ASCII only.
  v_exp_lower text := lower(coalesce(p_expected, '') collate "und-x-icu");
  v_user_lower text := lower(coalesce(p_user, '') collate "und-x-icu");
  v_exp_np text;
  v_user_np text;
  v_exp_words integer;
  v_user_words integer;
begin
  if v_exp_lower = v_user_lower then
    return 'capitalization';
  end if;
  -- removePunctuation(x).replace(/\s+/g, " ").trim()
  v_exp_np := regexp_replace(fn_js_remove_punctuation(v_exp_lower), '[' || v_ws || ']+', ' ', 'g');
  v_exp_np := regexp_replace(v_exp_np, '^[' || v_ws || ']+|[' || v_ws || ']+$', '', 'g');
  v_user_np := regexp_replace(fn_js_remove_punctuation(v_user_lower), '[' || v_ws || ']+', ' ', 'g');
  v_user_np := regexp_replace(v_user_np, '^[' || v_ws || ']+|[' || v_ws || ']+$', '', 'g');
  if v_exp_np = v_user_np then
    return 'punctuation';
  end if;
  -- split(" ").filter(Boolean).length
  v_exp_words := coalesce(array_length(array_remove(string_to_array(coalesce(p_expected, ''), ' '), ''), 1), 0);
  v_user_words := coalesce(array_length(array_remove(string_to_array(coalesce(p_user, ''), ' '), ''), 1), 0);
  if v_user_words < v_exp_words then
    return 'missing_word';
  end if;
  if v_user_words > v_exp_words then
    return 'extra_word';
  end if;
  return 'wrong_form';
end;
$$;

-- -------------------------------------------------------------------------
-- 4. Progress (coverage, attempt count, latest-per-sentence accuracy)
-- -------------------------------------------------------------------------

create or replace function fn_round_progress(p_round_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_round record;
  v_dictation integer;
  v_shadowing integer;
  v_overall integer;
  v_attempts integer;
  v_practiced integer;
  v_correct integer;
begin
  select transcript_id, required_sentence_count into v_round from learning_sessions where id = p_round_id;

  -- Coverage: distinct ELIGIBLE sentence identities (same rule as
  -- required_sentence_count), valid practice only; Listening never counts.
  with eligible as (
    select segment_index from transcript_segments
    where transcript_id = v_round.transcript_id and text_normalized <> ''
  ),
  d as (
    select distinct a.segment_index from attempt_logs a join eligible e using (segment_index)
    where a.session_id = p_round_id and a.is_practice_valid
  ),
  s as (
    select distinct sa.segment_index from shadowing_attempts sa join eligible e using (segment_index)
    where sa.round_id = p_round_id and sa.is_practice_valid
  )
  select (select count(*) from d), (select count(*) from s),
         (select count(*) from (select segment_index from d union select segment_index from s) u)
    into v_dictation, v_shadowing, v_overall;

  select count(*) into v_attempts from attempt_logs where session_id = p_round_id;

  -- Sentence accuracy: correct LATEST Dictation attempt per practiced
  -- sentence ÷ Dictation-practiced sentences. Repeats never add to the
  -- denominator.
  select count(*), count(*) filter (where is_correct) into v_practiced, v_correct
  from (
    select distinct on (segment_index) segment_index, is_correct
    from attempt_logs
    where session_id = p_round_id and is_practice_valid
    order by segment_index, created_at desc, id desc
  ) latest;

  return jsonb_build_object(
    'requiredSentenceCount', v_round.required_sentence_count,
    'coveredSentences', jsonb_build_object('dictation', v_dictation, 'shadowing', v_shadowing, 'overall', v_overall),
    'coverage', jsonb_build_object(
      'dictation', case when v_round.required_sentence_count > 0 then round(v_dictation::numeric / v_round.required_sentence_count, 4) else null end,
      'shadowing', case when v_round.required_sentence_count > 0 then round(v_shadowing::numeric / v_round.required_sentence_count, 4) else null end,
      'overall',   case when v_round.required_sentence_count > 0 then round(v_overall::numeric / v_round.required_sentence_count, 4) else null end
    ),
    'attemptCount', v_attempts,
    'sentenceAccuracy', jsonb_build_object(
      'correct', v_correct,
      'practiced', v_practiced,
      'percent', case when v_practiced > 0 then round(100.0 * v_correct / v_practiced) else null end
    )
  );
end;
$$;

-- Completes an active, not-yet-completed round whose eligible coverage
-- reached its positive required count. Caller must hold the round lock.
create or replace function fn_try_complete_round(p_round_id uuid)
returns boolean
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_round record;
  v_overall integer;
begin
  select status, completed_at, transcript_id, required_sentence_count into v_round
    from learning_sessions where id = p_round_id;
  if v_round.status <> 'active' or v_round.completed_at is not null
     or coalesce(v_round.required_sentence_count, 0) <= 0 then
    return false;
  end if;
  select count(*) into v_overall from (
    select a.segment_index from attempt_logs a
      join transcript_segments ts on ts.transcript_id = v_round.transcript_id
        and ts.segment_index = a.segment_index and ts.text_normalized <> ''
      where a.session_id = p_round_id and a.is_practice_valid
    union
    select sa.segment_index from shadowing_attempts sa
      join transcript_segments ts on ts.transcript_id = v_round.transcript_id
        and ts.segment_index = sa.segment_index and ts.text_normalized <> ''
      where sa.round_id = p_round_id and sa.is_practice_valid
  ) u;
  if v_overall < v_round.required_sentence_count then
    return false;
  end if;
  update learning_sessions
     set status = 'completed', completed_at = clock_timestamp(), completed_at_approximate = false
   where id = p_round_id and status = 'active' and completed_at is null;
  return found;
end;
$$;

-- JS-compatible "has content" predicate: false for NULL, '' and any string
-- made only of the ECMAScript whitespace set (tab, CR/LF, NBSP, U+2000–200A,
-- U+2028/2029, U+3000, BOM, …). Deliberately NOT based on grading
-- normalization — relaxed grading strips non-ASCII letters, which are real
-- content (an answer of "Ω" is wrong, not empty).
create or replace function fn_js_has_content(p_text text)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select fn_js_normalize_whitespace(p_text) <> '';
$$;

-- Validates a client-supplied study-session id for a practice write on
-- round p_round_id. Relationship rules only (read-only): the session must
-- exist and belong to the caller and the video, and — if it is attached to
-- a round — to THIS round. A round-less (Listening-only) session is
-- relationship-valid; it is simply never reused for round practice.
-- Raises study_session_mismatch otherwise.
create or replace function fn_validate_supplied_study_session(p_session_id uuid, p_user_id uuid, p_youtube_video_id text, p_round_id uuid)
returns void
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  perform 1 from study_sessions
    where id = p_session_id and user_id = p_user_id and youtube_video_id = p_youtube_video_id
      and (round_id is null or round_id = p_round_id);
  if not found then raise exception 'study_session_mismatch'; end if;
end;
$$;

-- Server-side study-session attribution for a NEW practice write (never
-- called for an idempotent retry). One rule set whether or not the client
-- supplied a session id (plan §5.3):
--   * a session is reusable only if it is open (ended_at is null), idle for
--     at most 30 minutes, and attached to exactly this round — a session's
--     round_id is never re-pointed, so a round-less Listening session is
--     closed instead of adopted;
--   * a supplied id is a hint: relationship-checked (above), reused if
--     reusable, otherwise ignored in favour of the automatic rule — an
--     ended or expired session is never reopened or touched;
--   * reuse bumps last_activity_at and records the mode in modes_used; a new
--     session starts with modes_used = [mode];
--   * a SUPERSEDED round (abandoned, or not the video's current round
--     because another round is active) never closes or opens sessions: the
--     late attempt is kept as that round's history and is attributed only to
--     a still-reusable session of that same round, else to none (NULL) — a
--     historical session is never fabricated.
-- Caller holds the gate → (user, video) advisory lock → round row lock, so
-- this runs under the same lock order as every other writer.
-- The first 037 draft had a 4-argument version; never applied remotely,
-- dropped so a stale overload can never linger in a rebuilt database.
drop function if exists fn_attribute_study_session(uuid, text, uuid, text);

create or replace function fn_attribute_study_session(
  p_user_id uuid,
  p_youtube_video_id text,
  p_round_id uuid,
  p_mode text,
  p_requested_session_id uuid default null
)
returns uuid
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_session record;
  v_new_id uuid;
  v_superseded boolean;
begin
  if p_requested_session_id is not null then
    perform fn_validate_supplied_study_session(p_requested_session_id, p_user_id, p_youtube_video_id, p_round_id);
    select * into v_session from study_sessions where id = p_requested_session_id for update;
    if v_session.ended_at is null and v_session.round_id = p_round_id
       and v_session.last_activity_at >= now() - interval '30 minutes' then
      update study_sessions
         set last_activity_at = now(),
             modes_used = case when modes_used ? p_mode then modes_used else modes_used || to_jsonb(p_mode) end
       where id = v_session.id;
      return v_session.id;
    end if;
  end if;

  select status <> 'active'
         and (status = 'abandoned'
              or exists (select 1 from learning_sessions o
                          where o.user_id = p_user_id and o.youtube_video_id = p_youtube_video_id
                            and o.status = 'active' and o.id <> p_round_id))
    into v_superseded
    from learning_sessions where id = p_round_id;

  if coalesce(v_superseded, true) then
    select * into v_session from study_sessions
      where user_id = p_user_id and youtube_video_id = p_youtube_video_id and round_id = p_round_id
        and ended_at is null and last_activity_at >= now() - interval '30 minutes'
      order by last_activity_at desc limit 1
      for update;
    if not found then return null; end if;
    update study_sessions
       set last_activity_at = now(),
           modes_used = case when modes_used ? p_mode then modes_used else modes_used || to_jsonb(p_mode) end
     where id = v_session.id;
    return v_session.id;
  end if;

  select * into v_session from study_sessions
    where user_id = p_user_id and youtube_video_id = p_youtube_video_id and ended_at is null
    order by last_activity_at desc limit 1
    for update;
  if found and v_session.last_activity_at >= now() - interval '30 minutes'
     and v_session.round_id is not distinct from p_round_id then
    update study_sessions
       set last_activity_at = now(),
           modes_used = case when modes_used ? p_mode then modes_used else modes_used || to_jsonb(p_mode) end
     where id = v_session.id;
    return v_session.id;
  end if;
  if found then
    update study_sessions set ended_at = now() where id = v_session.id;
  end if;
  insert into study_sessions (user_id, round_id, youtube_video_id, modes_used)
    values (p_user_id, p_round_id, p_youtube_video_id, jsonb_build_array(p_mode))
    returning id into v_new_id;
  return v_new_id;
end;
$$;

-- -------------------------------------------------------------------------
-- 5. Authoritative round lifecycle (replaces the dormant 035 versions)
-- -------------------------------------------------------------------------

drop function if exists fn_create_or_get_active_round(text);
drop function if exists fn_update_resume_position(uuid, integer, numeric);
drop function if exists fn_restart_round(text);

create or replace function fn_create_or_get_active_round(
  p_youtube_video_id text,
  p_expected_transcript_id uuid default null,
  p_segment_index integer default null,
  p_video_current_time_sec numeric default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_round record;
  v_transcript_id uuid;
  v_required integer;
  v_round_number integer;
  v_new_id uuid;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_youtube_video_id is null or btrim(p_youtube_video_id) = '' then raise exception 'invalid_payload'; end if;
  if p_segment_index is not null and p_segment_index < 0 then raise exception 'invalid_payload'; end if;
  if p_video_current_time_sec is not null
     and (p_video_current_time_sec < 0 or p_video_current_time_sec = 'NaN'::numeric or p_video_current_time_sec > 86400) then
    raise exception 'invalid_payload';
  end if;

  perform fn_check_authoritative_write_gate();
  perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || p_youtube_video_id));

  select id, transcript_id, round_number, required_sentence_count, provenance into v_round
    from learning_sessions
    where user_id = v_user_id and youtube_video_id = p_youtube_video_id and status = 'active'
    for update;

  if found then
    -- Reusing the active round: the request must have been produced
    -- against this round's own pinned revision.
    if p_expected_transcript_id is not null and v_round.transcript_id is not null
       and p_expected_transcript_id <> v_round.transcript_id then
      raise exception 'stale_transcript_revision';
    end if;
    if p_segment_index is not null then
      update learning_sessions
         set current_segment_index = p_segment_index,
             video_current_time = coalesce(p_video_current_time_sec, video_current_time),
             updated_at = now()
       where id = v_round.id;
    end if;
    return jsonb_build_object(
      'roundId', v_round.id, 'created', false, 'transcriptId', v_round.transcript_id,
      'roundNumber', v_round.round_number, 'requiredSentenceCount', v_round.required_sentence_count,
      'roundStatus', 'active', 'provenance', v_round.provenance
    );
  end if;

  -- New round: server-resolved current ready revision; the client's
  -- expectation is checked BEFORE anything is written.
  select id into v_transcript_id from transcripts
    where youtube_video_id = p_youtube_video_id and language = 'en'
      and is_current = true and status = 'ready';
  if v_transcript_id is null then raise exception 'transcript_not_ready'; end if;
  if p_expected_transcript_id is not null and p_expected_transcript_id <> v_transcript_id then
    raise exception 'stale_transcript_revision';
  end if;

  v_required := fn_eligible_segment_count(v_transcript_id);
  select coalesce(max(round_number), 0) + 1 into v_round_number
    from learning_sessions where user_id = v_user_id and youtube_video_id = p_youtube_video_id;

  insert into learning_sessions (
    user_id, youtube_video_id, transcript_id, status, provenance, round_number, required_sentence_count,
    current_segment_index, video_current_time
  ) values (
    v_user_id, p_youtube_video_id, v_transcript_id, 'active', 'current', v_round_number, v_required,
    coalesce(p_segment_index, 0), coalesce(p_video_current_time_sec, 0)
  ) returning id into v_new_id;

  return jsonb_build_object(
    'roundId', v_new_id, 'created', true, 'transcriptId', v_transcript_id,
    'roundNumber', v_round_number, 'requiredSentenceCount', v_required,
    'roundStatus', 'active', 'provenance', 'current'
  );
end;
$$;

create or replace function fn_update_resume_position(
  p_round_id uuid,
  p_youtube_video_id text,
  p_segment_index integer,
  p_video_current_time_sec numeric,
  p_expected_transcript_id uuid default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_round record;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_round_id is null or p_youtube_video_id is null or p_segment_index is null or p_segment_index < 0 then
    raise exception 'invalid_payload';
  end if;
  if p_video_current_time_sec is not null
     and (p_video_current_time_sec < 0 or p_video_current_time_sec = 'NaN'::numeric or p_video_current_time_sec > 86400) then
    raise exception 'invalid_payload';
  end if;

  perform fn_check_authoritative_write_gate();
  perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || p_youtube_video_id));

  select id, status, transcript_id into v_round
    from learning_sessions
    where id = p_round_id and user_id = v_user_id and youtube_video_id = p_youtube_video_id
    for update;
  if not found then raise exception 'round_not_found'; end if;
  if p_expected_transcript_id is not null and v_round.transcript_id is not null
     and p_expected_transcript_id <> v_round.transcript_id then
    raise exception 'stale_transcript_revision';
  end if;

  -- Only these two convenience columns are ever written here; a
  -- completed/abandoned round keeps its final checkpoint.
  if v_round.status <> 'active' then
    return jsonb_build_object('roundId', v_round.id, 'applied', false, 'roundStatus', v_round.status);
  end if;
  update learning_sessions
     set current_segment_index = p_segment_index,
         video_current_time = coalesce(p_video_current_time_sec, video_current_time),
         updated_at = now()
   where id = v_round.id;
  return jsonb_build_object('roundId', v_round.id, 'applied', true, 'roundStatus', 'active');
end;
$$;

create or replace function fn_restart_round(
  p_youtube_video_id text,
  p_expected_round_id uuid default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_active record;
  v_transcript_id uuid;
  v_required integer;
  v_round_number integer;
  v_new_round_id uuid;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_youtube_video_id is null or btrim(p_youtube_video_id) = '' then raise exception 'invalid_payload'; end if;

  perform fn_check_authoritative_write_gate();
  perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || p_youtube_video_id));

  select id, transcript_id, round_number, required_sentence_count into v_active
    from learning_sessions
    where user_id = v_user_id and youtube_video_id = p_youtube_video_id and status = 'active'
    for update;

  -- Retry-safe: the caller asked to restart round X, but the active round
  -- is already a different one (X was restarted by an earlier attempt of
  -- this same request, or by another tab) — return it, don't restart again.
  if found and p_expected_round_id is not null and v_active.id <> p_expected_round_id then
    return jsonb_build_object(
      'roundId', v_active.id, 'created', false, 'transcriptId', v_active.transcript_id,
      'roundNumber', v_active.round_number, 'requiredSentenceCount', v_active.required_sentence_count,
      'abandonedRoundId', null
    );
  end if;

  -- Resolve the new round's revision BEFORE changing anything.
  select id into v_transcript_id from transcripts
    where youtube_video_id = p_youtube_video_id and language = 'en'
      and is_current = true and status = 'ready';
  if v_transcript_id is null then raise exception 'transcript_not_ready'; end if;

  if v_active.id is not null then
    update learning_sessions set status = 'abandoned', updated_at = now() where id = v_active.id;
  end if;

  -- An explicit new round always ends the open study session (§5.3 rule 4).
  update study_sessions set ended_at = now()
   where user_id = v_user_id and youtube_video_id = p_youtube_video_id and ended_at is null;

  v_required := fn_eligible_segment_count(v_transcript_id);
  select coalesce(max(round_number), 0) + 1 into v_round_number
    from learning_sessions where user_id = v_user_id and youtube_video_id = p_youtube_video_id;

  insert into learning_sessions (
    user_id, youtube_video_id, transcript_id, status, provenance, round_number, required_sentence_count
  ) values (
    v_user_id, p_youtube_video_id, v_transcript_id, 'active', 'current', v_round_number, v_required
  ) returning id into v_new_round_id;

  return jsonb_build_object(
    'roundId', v_new_round_id, 'created', true, 'transcriptId', v_transcript_id,
    'roundNumber', v_round_number, 'requiredSentenceCount', v_required,
    'abandonedRoundId', v_active.id
  );
end;
$$;

-- -------------------------------------------------------------------------
-- 6. Authoritative attempts
-- -------------------------------------------------------------------------

drop function if exists fn_record_dictation_attempt(uuid, text, integer, uuid, text, text, text, uuid, uuid, smallint);

create or replace function fn_record_dictation_attempt(
  p_round_id uuid,
  p_youtube_video_id text,
  p_segment_index integer,
  p_client_attempt_id uuid,
  p_user_text text,
  p_match_mode text default 'relaxed',
  p_transcript_id uuid default null,
  p_study_session_id uuid default null,
  p_hint_level_used smallint default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_video text;
  v_round record;
  v_segment record;
  v_existing record;
  v_mode text := coalesce(p_match_mode, 'relaxed');
  v_norm_expected text;
  v_norm_user text;
  v_is_correct boolean;
  v_error_type text;
  v_attempt record;
  v_study_session_id uuid;
  v_completed boolean := false;
  v_progress jsonb;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_round_id is null or p_client_attempt_id is null or p_user_text is null
     or p_segment_index is null or p_segment_index < 0 or length(p_user_text) > 2000
     or (p_hint_level_used is not null and (p_hint_level_used < 0 or p_hint_level_used > 4)) then
    raise exception 'invalid_payload';
  end if;
  if v_mode not in ('exact', 'relaxed', 'learning') then v_mode := 'relaxed'; end if;

  perform fn_check_authoritative_write_gate();

  -- The video is part of the lock key; old clients may omit it, in which
  -- case it is taken from the caller's own round (ownership still enforced).
  select youtube_video_id into v_video from learning_sessions where id = p_round_id and user_id = v_user_id;
  if not found then raise exception 'round_not_found'; end if;
  if p_youtube_video_id is not null and p_youtube_video_id <> v_video then raise exception 'round_not_found'; end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || v_video));
  select id, status, transcript_id, required_sentence_count into v_round
    from learning_sessions
    where id = p_round_id and user_id = v_user_id and youtube_video_id = v_video
    for update;
  if not found then raise exception 'round_not_found'; end if;

  if p_transcript_id is not null and p_transcript_id is distinct from v_round.transcript_id then
    raise exception 'stale_transcript_revision';
  end if;
  if v_round.transcript_id is null then
    -- A legacy round with no pinned revision: its sentence identities
    -- cannot be verified, so no verified attempt can be recorded on it.
    raise exception 'round_transcript_unknown';
  end if;

  select id, text_raw into v_segment from transcript_segments
    where transcript_id = v_round.transcript_id and segment_index = p_segment_index;
  if not found then raise exception 'segment_not_found'; end if;

  v_norm_expected := fn_normalize_dictation_text(v_segment.text_raw, v_mode);
  v_norm_user := fn_normalize_dictation_text(p_user_text, v_mode);

  -- Idempotency: one logical submission = one client_attempt_id per round.
  -- The immutable request identity is (segment, raw text, effective grading
  -- mode, hint level); the study session is server-assigned attribution,
  -- not request data, so it is never compared (the supplied id is only
  -- relationship-checked, read-only). A stored row with no recorded mode
  -- (written before match_mode existed) can never be proven to be the same
  -- request, so reusing its key is a conflict — the mode is never inferred.
  select * into v_existing from attempt_logs
    where session_id = p_round_id and client_attempt_id = p_client_attempt_id;
  if found then
    if p_study_session_id is not null then
      perform fn_validate_supplied_study_session(p_study_session_id, v_user_id, v_video, p_round_id);
    end if;
    if v_existing.segment_index <> p_segment_index
       or v_existing.user_text is distinct from p_user_text
       or v_existing.match_mode is null
       or v_existing.match_mode <> v_mode
       or v_existing.normalized_user_text is distinct from v_norm_user
       or v_existing.hint_level_used is distinct from p_hint_level_used then
      raise exception 'idempotency_key_reused_with_different_payload';
    end if;
    -- Genuine retry: the stored attempt, untouched, no side effects (no
    -- study session is updated, reopened or created).
    return jsonb_build_object(
      'attemptId', v_existing.id, 'wasInserted', false,
      'isCorrect', v_existing.is_correct, 'errorType', coalesce(v_existing.error_type, 'none'),
      'matchMode', v_existing.match_mode,
      'normalizedExpected', v_existing.normalized_expected_text, 'normalizedUser', v_existing.normalized_user_text,
      'studySessionId', v_existing.study_session_id,
      'roundCompletedByThisRequest', false,
      'roundStatus', v_round.status,
      'progress', fn_round_progress(p_round_id)
    );
  end if;

  v_study_session_id := fn_attribute_study_session(v_user_id, v_video, p_round_id, 'dictation', p_study_session_id);

  v_is_correct := (v_norm_expected = v_norm_user);
  v_error_type := case when v_is_correct then 'none' else fn_classify_dictation_error(v_norm_expected, v_norm_user) end;

  insert into attempt_logs (
    session_id, segment_index, expected_text, user_text,
    normalized_expected_text, normalized_user_text,
    is_correct, error_type, client_attempt_id, study_session_id,
    hint_level_used, is_practice_valid, transcript_id, segment_id,
    segment_identity_provenance, match_mode, created_at
  ) values (
    p_round_id, p_segment_index, v_segment.text_raw, p_user_text,
    v_norm_expected, v_norm_user,
    v_is_correct, v_error_type, p_client_attempt_id, v_study_session_id,
    -- An empty / whitespace-only answer is stored (history) but is never
    -- practice: it earns no coverage and cannot complete the round.
    p_hint_level_used, fn_js_has_content(p_user_text), v_round.transcript_id, v_segment.id,
    'verified', v_mode, clock_timestamp()
  )
  returning * into v_attempt;

  -- Server-maintained counters with the SAME meaning the legacy client
  -- counters had: Dictation submissions, and correct ÷ submissions.
  update learning_sessions ls
     set total_attempts = c.total,
         accuracy = case when c.total > 0 then round(100.0 * c.correct / c.total) else 0 end,
         updated_at = now()
    from (select count(*) as total, count(*) filter (where is_correct) as correct
            from attempt_logs where session_id = p_round_id) c
   where ls.id = p_round_id;

  v_completed := fn_try_complete_round(p_round_id);
  v_progress := fn_round_progress(p_round_id);

  return jsonb_build_object(
    'attemptId', v_attempt.id, 'wasInserted', true,
    'isCorrect', v_attempt.is_correct, 'errorType', v_attempt.error_type,
    'matchMode', v_attempt.match_mode,
    'normalizedExpected', v_attempt.normalized_expected_text, 'normalizedUser', v_attempt.normalized_user_text,
    'studySessionId', v_study_session_id,
    'roundCompletedByThisRequest', v_completed,
    'roundStatus', (select status from learning_sessions where id = p_round_id),
    'progress', v_progress
  );
end;
$$;

-- Same signature as 033 (dormant until activation); body aligned with the
-- dictation function: gate, lock order, full-payload idempotency,
-- eligible-only completion, server-side study-session attribution.
create or replace function fn_record_shadowing_attempt(
  p_round_id uuid,
  p_youtube_video_id text,
  p_segment_index integer,
  p_client_attempt_id uuid,
  p_recording_duration_sec numeric,
  p_transcript_id uuid default null,
  p_study_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_round record;
  v_segment record;
  v_existing record;
  v_attempt record;
  v_study_session_id uuid;
  v_completed boolean := false;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_round_id is null or p_youtube_video_id is null or p_client_attempt_id is null
     or p_segment_index is null or p_segment_index < 0
     or p_recording_duration_sec is null or p_recording_duration_sec < 0
     or p_recording_duration_sec = 'NaN'::numeric or p_recording_duration_sec > 600 then
    raise exception 'invalid_payload';
  end if;

  perform fn_check_authoritative_write_gate();
  perform pg_advisory_xact_lock(hashtext(v_user_id::text || '::' || p_youtube_video_id));

  select id, status, transcript_id into v_round
    from learning_sessions
    where id = p_round_id and user_id = v_user_id and youtube_video_id = p_youtube_video_id
    for update;
  if not found then raise exception 'round_not_found'; end if;
  if p_transcript_id is not null and p_transcript_id is distinct from v_round.transcript_id then
    raise exception 'stale_transcript_revision';
  end if;
  if v_round.transcript_id is null then raise exception 'round_transcript_unknown'; end if;

  select id into v_segment from transcript_segments
    where transcript_id = v_round.transcript_id and segment_index = p_segment_index;
  if not found then raise exception 'segment_not_found'; end if;

  select * into v_existing from shadowing_attempts
    where round_id = p_round_id and client_attempt_id = p_client_attempt_id;
  if found then
    -- Same rule as Dictation: the study session is server-assigned
    -- attribution, relationship-checked (read-only) but never compared.
    if p_study_session_id is not null then
      perform fn_validate_supplied_study_session(p_study_session_id, v_user_id, p_youtube_video_id, p_round_id);
    end if;
    if v_existing.segment_index <> p_segment_index
       or v_existing.recording_duration_sec is distinct from p_recording_duration_sec then
      raise exception 'idempotency_key_reused_with_different_payload';
    end if;
    return jsonb_build_object(
      'attemptId', v_existing.id, 'wasInserted', false,
      'isPracticeValid', v_existing.is_practice_valid,
      'studySessionId', v_existing.study_session_id,
      'roundCompletedByThisRequest', false,
      'roundStatus', v_round.status,
      'progress', fn_round_progress(p_round_id)
    );
  end if;

  v_study_session_id := fn_attribute_study_session(v_user_id, p_youtube_video_id, p_round_id, 'shadowing', p_study_session_id);

  insert into shadowing_attempts (
    user_id, round_id, study_session_id, youtube_video_id, transcript_id,
    segment_index, segment_id, client_attempt_id, recording_duration_sec,
    is_practice_valid, validity_basis, created_at
  ) values (
    v_user_id, p_round_id, v_study_session_id, p_youtube_video_id, v_round.transcript_id,
    p_segment_index, v_segment.id, p_client_attempt_id, p_recording_duration_sec,
    p_recording_duration_sec >= 0.5, 'client_reported', clock_timestamp()
  )
  returning * into v_attempt;

  update learning_sessions set updated_at = now() where id = p_round_id;
  v_completed := fn_try_complete_round(p_round_id);

  return jsonb_build_object(
    'attemptId', v_attempt.id, 'wasInserted', true,
    'isPracticeValid', v_attempt.is_practice_valid,
    'studySessionId', v_study_session_id,
    'roundCompletedByThisRequest', v_completed,
    'roundStatus', (select status from learning_sessions where id = p_round_id),
    'progress', fn_round_progress(p_round_id)
  );
end;
$$;

-- The 032 coverage helper is superseded by fn_round_progress (which counts
-- only eligible sentences); nothing references it any more.
drop function if exists fn_round_coverage(uuid, integer);

-- -------------------------------------------------------------------------
-- 7. explain-all persistence (backend-only; used by the PREP release)
-- -------------------------------------------------------------------------

create or replace function fn_persist_session_assessment(
  p_session_id uuid,
  p_user_id uuid,
  p_assessment jsonb
)
returns boolean
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  if p_session_id is null or p_user_id is null or p_assessment is null
     or jsonb_typeof(p_assessment) = 'null' or pg_column_size(p_assessment) > 65536 then
    raise exception 'invalid_payload';
  end if;
  -- Only the two assessment fields; never lifecycle/provenance/counters,
  -- and never updated_at (an AI assessment is not practice activity).
  update learning_sessions
     set ai_assessment = p_assessment, ai_assessment_generated_at = now()
   where id = p_session_id and user_id = p_user_id;
  return found;
end;
$$;

-- -------------------------------------------------------------------------
-- 8. Operator-only cutover stage functions (SECURITY INVOKER; callable only
--    by the owning/superuser role — EXECUTE revoked from every app role)
-- -------------------------------------------------------------------------

create or replace function fn_phase3_log(p_event text, p_detail jsonb default '{}'::jsonb)
returns void
language sql
set search_path = public, pg_temp
as $$
  insert into phase3_cutover_log (event, detail) values (p_event, coalesce(p_detail, '{}'::jsonb));
$$;

-- Bounded waits: every stage function waits at most this long for a lock
-- (then fails and rolls back), unless the operator already set a
-- lock_timeout for the session — an explicit operator choice is kept.
create or replace function fn_phase3_default_lock_timeout()
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    perform set_config('lock_timeout', '15s', true);
  end if;
end;
$$;

create or replace function fn_phase3_status()
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'stage', s.stage,
    'directWritesRestrictedAt', s.direct_writes_restricted_at,
    'cutoverAt', s.cutover_at,
    'backfillCompletedAt', s.backfill_completed_at,
    'backfillRuns', s.backfill_runs,
    'activatedAt', s.activated_at,
    'gate', (select to_jsonb(g) from app_write_gate g where g.id = 1),
    'legacyBridgesPresent', jsonb_build_object(
      'fn_legacy_save_progress', to_regprocedure('public.fn_legacy_save_progress(uuid,text,uuid,integer,numeric,numeric,integer,text)') is not null,
      'fn_legacy_restart_round', to_regprocedure('public.fn_legacy_restart_round(text,uuid)') is not null,
      'fn_legacy_record_dictation_attempt', to_regprocedure('public.fn_legacy_record_dictation_attempt(uuid,integer,text,text,text,text,boolean,text)') is not null
    ),
    'learningSessionsPolicies', (select coalesce(jsonb_agg(policyname order by policyname), '[]') from pg_policies
                                 where schemaname = 'public' and tablename = 'learning_sessions'),
    'backfillSummary', s.backfill_summary
  )
  from phase3_cutover_state s where s.id = 1;
$$;

-- Step 2 of the runbook. Precondition (operator-verified, not checkable
-- here): every serving instance runs the PREP release, i.e. explain-all
-- uses fn_persist_session_assessment and the three writers use the Phase 2
-- bridges. Waits (bounded) for in-flight direct statements: DROP POLICY
-- takes an ACCESS EXCLUSIVE lock on learning_sessions.
create or replace function fn_phase3_restrict_direct_writes()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_state record;
begin
  perform fn_phase3_default_lock_timeout();
  select * into v_state from phase3_cutover_state where id = 1 for update;
  if not found then raise exception 'phase3_state_missing'; end if;
  if to_regprocedure('public.fn_persist_session_assessment(uuid,uuid,jsonb)') is null then
    raise exception 'precondition_failed: fn_persist_session_assessment missing';
  end if;

  drop policy if exists "sessions_owner" on learning_sessions;
  drop policy if exists "sessions_anon_insert" on learning_sessions;
  drop policy if exists "learning_sessions_owner_select" on learning_sessions;
  create policy "learning_sessions_owner_select" on learning_sessions
    for select to authenticated using (auth.uid() = user_id);

  -- GRANTs aligned with RLS: owners read; nobody writes directly. Every
  -- write goes through SECURITY DEFINER functions owned by the table owner.
  revoke all on learning_sessions from public, anon;
  revoke insert, update, delete, truncate, references, trigger on learning_sessions from authenticated, service_role;
  grant select on learning_sessions to authenticated, service_role;
  -- attempt_logs: service_role's direct INSERT (031) is no longer needed —
  -- dictation/check writes through a SECURITY DEFINER bridge/function.
  revoke insert on attempt_logs from service_role;

  if v_state.stage = 'prepared' then
    update phase3_cutover_state
       set stage = 'restricted', direct_writes_restricted_at = clock_timestamp(), updated_at = clock_timestamp()
     where id = 1;
  end if;
  perform fn_phase3_log('restrict_direct_writes', jsonb_build_object('previousStage', v_state.stage));
  return fn_phase3_status();
end;
$$;

-- Step 3: close and drain the legacy gate. FOR UPDATE waits for every
-- admitted bridge transaction (FOR SHARE holders) to finish; the boundary is
-- captured with clock_timestamp() AFTER the lock is acquired. Retrying while
-- already paused changes nothing (stable boundary).
create or replace function fn_phase3_close_gate()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_gate record;
  v_boundary timestamptz;
begin
  perform fn_phase3_default_lock_timeout();
  select * into v_state from phase3_cutover_state where id = 1 for update;
  if not found then raise exception 'phase3_state_missing'; end if;
  if v_state.stage in ('paused', 'backfilled') then
    return fn_phase3_status();
  end if;
  if v_state.stage <> 'restricted' then
    raise exception 'precondition_failed: stage is %, expected restricted', v_state.stage;
  end if;

  select * into v_gate from app_write_gate where id = 1 for update;
  if not found then raise exception 'write_gate_missing'; end if;
  if v_gate.legacy_writes_retired or v_gate.authoritative_writes_active then
    raise exception 'precondition_failed: gate already activated';
  end if;
  v_boundary := clock_timestamp();

  update app_write_gate set completion_writes_paused = true, paused_at = v_boundary where id = 1;
  update phase3_cutover_state set stage = 'paused', cutover_at = v_boundary, updated_at = clock_timestamp() where id = 1;
  perform fn_phase3_log('close_gate', jsonb_build_object('cutoverAt', v_boundary));
  return fn_phase3_status();
end;
$$;

-- Step 4: bounded, audited legacy backfill. One transaction: it either
-- commits completely (stage → backfilled) or leaves no trace. Re-running
-- after success is a no-op; after activation it is refused.
create or replace function fn_phase3_backfill()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_gate record;
  v_batch integer;
  v_triggers text;
  v_summary jsonb;
begin
  perform fn_phase3_default_lock_timeout();
  select * into v_state from phase3_cutover_state where id = 1 for update;
  if not found then raise exception 'phase3_state_missing'; end if;
  if v_state.stage = 'backfilled' then
    return fn_phase3_status();
  end if;
  if v_state.stage <> 'paused' then
    raise exception 'precondition_failed: stage is %, expected paused', v_state.stage;
  end if;
  select * into v_gate from app_write_gate where id = 1 for share;
  if not found then raise exception 'write_gate_missing'; end if;
  if not v_gate.completion_writes_paused or v_gate.authoritative_writes_active or v_gate.legacy_writes_retired then
    raise exception 'precondition_failed: gate must be paused and not activated';
  end if;

  -- User triggers could rewrite updated_at/completed_at behind our back.
  select string_agg(tgrelid::regclass || '.' || tgname, ', ') into v_triggers
    from pg_trigger
   where not tgisinternal and tgrelid in ('public.learning_sessions'::regclass, 'public.attempt_logs'::regclass);
  if v_triggers is not null then
    raise exception 'precondition_failed: unexpected triggers present: %', v_triggers;
  end if;

  -- Consistent cohort: nothing else may write either table while we run.
  lock table learning_sessions, attempt_logs in share row exclusive mode;

  v_batch := v_state.backfill_runs + 1;

  -- 4a. Capture the round cohort's original values (never overwritten).
  --     Cohort = every round still marked 'current'. Before activation no
  --     authoritative writer can have run (the authoritative gate refuses),
  --     so every such row was written by a legacy path — including rows
  --     whose client-writable started_at lies after the boundary, which are
  --     flagged as anomalies rather than silently excluded.
  insert into phase3_backfill_rounds (
    round_id, user_id, youtube_video_id, transcript_id, orig_status, orig_provenance,
    orig_round_number, orig_required_sentence_count, orig_completed_at,
    orig_started_at, orig_updated_at, cutover_at, batch, anomalies
  )
  select ls.id, ls.user_id, ls.youtube_video_id, ls.transcript_id, ls.status, ls.provenance,
         ls.round_number, ls.required_sentence_count, ls.completed_at,
         ls.started_at, ls.updated_at, v_state.cutover_at, v_batch,
         array_remove(array[
           case when ls.started_at > v_state.cutover_at then 'started_after_cutover' end,
           case when ls.updated_at < ls.started_at then 'updated_before_started' end,
           case when ls.updated_at > v_state.cutover_at then 'updated_after_cutover' end,
           case when ls.user_id is null then 'anonymous_row' end,
           case when ls.transcript_id is null then 'no_transcript_pin' end,
           case when ls.transcript_id is not null
                 and not exists (select 1 from transcripts t where t.id = ls.transcript_id) then 'pinned_transcript_missing' end
         ], null)
    from learning_sessions ls
   where ls.provenance = 'current'
  on conflict (round_id) do nothing;

  -- 4b. Round numbers for this batch: per (user, video), ordered by
  --     started_at then id (stable tie-break), continuing after any number
  --     an earlier batch already assigned. Anonymous rows are never grouped
  --     together — each is its own sequence.
  with batch_rows as (
    select b.round_id,
           coalesce(b.user_id::text, 'anon:' || b.round_id::text) || '::' || b.youtube_video_id as grp,
           b.orig_started_at
      from phase3_backfill_rounds b where b.batch = v_batch
  ),
  prior as (
    select coalesce(b.user_id::text, 'anon:' || b.round_id::text) || '::' || b.youtube_video_id as grp,
           max(b.new_round_number) as max_no
      from phase3_backfill_rounds b where b.batch < v_batch group by 1
  ),
  numbered as (
    select r.round_id,
           coalesce(p.max_no, 0) + row_number() over (partition by r.grp order by r.orig_started_at, r.round_id) as rn
      from batch_rows r left join prior p on p.grp = r.grp
  )
  update phase3_backfill_rounds b
     set new_round_number = n.rn,
         new_required_sentence_count = coalesce(
           b.orig_required_sentence_count,
           case when exists (select 1 from transcripts t where t.id = b.transcript_id)
                then fn_eligible_segment_count(b.transcript_id) end),
         new_completed_at = case
           when b.orig_status = 'completed' and b.orig_completed_at is null
             then least(greatest(b.orig_updated_at, b.orig_started_at), b.cutover_at)
           else b.orig_completed_at end,
         completed_at_inferred = (b.orig_status = 'completed' and b.orig_completed_at is null)
    from numbered n
   where b.round_id = n.round_id;

  -- 4c. Apply to the rounds. updated_at is deliberately NOT touched
  --     (no triggers exist — checked above), so "last practiced" ordering
  --     and the evidence the inference used are preserved.
  update learning_sessions ls
     set provenance = 'legacy_unverified',
         round_number = b.new_round_number,
         required_sentence_count = b.new_required_sentence_count,
         completed_at = b.new_completed_at,
         completed_at_approximate = ls.completed_at_approximate or b.completed_at_inferred
    from phase3_backfill_rounds b
   where b.round_id = ls.id and b.batch = v_batch and ls.provenance = 'current';

  -- 4d. Attempts: every attempt still marked 'verified' (all were written by
  --     the client-trusting legacy paths). Identity is filled only where the
  --     round's pin resolves AND the stored reference text matches that
  --     segment; otherwise it stays null and the reason is recorded. Never
  --     repinned to the latest transcript. hint_level_used is not touched.
  insert into phase3_backfill_attempts (
    attempt_id, round_id, orig_segment_identity_provenance, orig_transcript_id, orig_segment_id,
    identity_resolution, batch
  )
  select a.id, a.session_id, a.segment_identity_provenance, a.transcript_id, a.segment_id,
         case
           when a.transcript_id is not null and a.segment_id is not null then 'already_set'
           when ls.transcript_id is null or not exists (select 1 from transcripts t where t.id = ls.transcript_id)
             then 'unresolved_no_round_pin'
           when ts.id is null then 'unresolved_no_segment'
           when ts.text_raw is distinct from a.expected_text then 'unresolved_text_mismatch'
           else 'resolved_text_match'
         end,
         v_batch
    from attempt_logs a
    join learning_sessions ls on ls.id = a.session_id
    left join transcript_segments ts on ts.transcript_id = ls.transcript_id and ts.segment_index = a.segment_index
   where a.segment_identity_provenance = 'verified'
  on conflict (attempt_id) do nothing;

  update attempt_logs a
     set segment_identity_provenance = 'legacy_unverified',
         transcript_id = case when pa.identity_resolution = 'resolved_text_match' then ls.transcript_id else a.transcript_id end,
         segment_id = case when pa.identity_resolution = 'resolved_text_match'
                           then (select ts.id from transcript_segments ts
                                  where ts.transcript_id = ls.transcript_id and ts.segment_index = a.segment_index)
                           else a.segment_id end
    from phase3_backfill_attempts pa
    join learning_sessions ls on ls.id = pa.round_id
   where pa.attempt_id = a.id and pa.batch = v_batch
     and a.segment_identity_provenance = 'verified';

  -- 4e'. A round captured by an EARLIER batch that a legacy writer marked
  --      completed during a return-to-legacy interval (fn_phase3_reopen_legacy)
  --      gets the same approximate completion time; its captured originals
  --      are not touched.
  update learning_sessions ls
     set completed_at = least(greatest(ls.updated_at, ls.started_at), v_state.cutover_at),
         completed_at_approximate = true
    from phase3_backfill_rounds b
   where b.round_id = ls.id and b.batch < v_batch
     and ls.status = 'completed' and ls.completed_at is null;

  -- 4e. Verify: nothing legacy left unclassified.
  if exists (select 1 from learning_sessions where provenance = 'current') then
    raise exception 'backfill_verification_failed: rounds still current';
  end if;
  if exists (select 1 from attempt_logs where segment_identity_provenance = 'verified') then
    raise exception 'backfill_verification_failed: attempts still verified';
  end if;

  select jsonb_build_object(
    'batch', v_batch,
    'cutoverAt', v_state.cutover_at,
    'rounds', (select count(*) from phase3_backfill_rounds where batch = v_batch),
    'roundsByStatus', (select coalesce(jsonb_object_agg(orig_status, n), '{}') from
                       (select orig_status, count(*) n from phase3_backfill_rounds where batch = v_batch group by 1) x),
    'completedAtInferred', (select count(*) from phase3_backfill_rounds where batch = v_batch and completed_at_inferred),
    'requiredCountUnknown', (select count(*) from phase3_backfill_rounds where batch = v_batch and new_required_sentence_count is null),
    'anomalies', (select coalesce(jsonb_object_agg(a, n), '{}') from
                  (select unnest(anomalies) a, count(*) n from phase3_backfill_rounds where batch = v_batch group by 1) x),
    'attempts', (select count(*) from phase3_backfill_attempts where batch = v_batch),
    'attemptIdentity', (select coalesce(jsonb_object_agg(identity_resolution, n), '{}') from
                        (select identity_resolution, count(*) n from phase3_backfill_attempts where batch = v_batch group by 1) x)
  ) into v_summary;

  update phase3_cutover_state
     set stage = 'backfilled', backfill_completed_at = clock_timestamp(), backfill_runs = v_batch,
         backfill_summary = v_summary, updated_at = clock_timestamp()
   where id = 1;
  perform fn_phase3_log('backfill', v_summary);
  return fn_phase3_status();
end;
$$;

-- Step 6: permanent retirement + activation + reopen, one transaction.
-- (The application deployment is NOT part of this transaction; it must be
-- complete — every instance on the Phase 3 release — before calling this.)
create or replace function fn_phase3_activate()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_state record;
  v_sig text;
begin
  perform fn_phase3_default_lock_timeout();
  select * into v_state from phase3_cutover_state where id = 1 for update;
  if not found then raise exception 'phase3_state_missing'; end if;
  if v_state.stage = 'activated' then
    return fn_phase3_status();
  end if;
  if v_state.stage <> 'backfilled' then
    raise exception 'precondition_failed: stage is %, expected backfilled', v_state.stage;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'learning_sessions'
             and policyname in ('sessions_owner', 'sessions_anon_insert')) then
    raise exception 'precondition_failed: direct-write policies still present';
  end if;

  -- Waits for any queued bridge call holding FOR SHARE (all of them are
  -- being refused while paused, but they still take the lock first).
  perform 1 from app_write_gate where id = 1 and completion_writes_paused for update;
  if not found then raise exception 'precondition_failed: gate is not paused'; end if;

  -- (1) Legacy writes can never resume: the durable flag is checked inside
  --     every bridge's own gate read, so a call queued behind THIS
  --     transaction re-reads the committed row and is refused even though
  --     it already started executing the bridge body.
  update app_write_gate set legacy_writes_retired = true where id = 1;
  drop function if exists fn_legacy_save_progress(uuid, text, uuid, integer, numeric, numeric, integer, text);
  drop function if exists fn_legacy_restart_round(text, uuid);
  drop function if exists fn_legacy_record_dictation_attempt(uuid, integer, text, text, text, text, boolean, text);

  -- (2) Authoritative writers: authenticated only, exact signatures.
  foreach v_sig in array array[
    'public.fn_create_or_get_active_round(text,uuid,integer,numeric)',
    'public.fn_update_resume_position(uuid,text,integer,numeric,uuid)',
    'public.fn_restart_round(text,uuid)',
    'public.fn_record_dictation_attempt(uuid,text,integer,uuid,text,text,uuid,uuid,smallint)',
    'public.fn_record_shadowing_attempt(uuid,text,integer,uuid,numeric,uuid,uuid)'
  ] loop
    if to_regprocedure(v_sig) is null then
      raise exception 'precondition_failed: % missing', v_sig;
    end if;
    execute format('revoke execute on function %s from public, anon, service_role', v_sig);
    execute format('grant execute on function %s to authenticated', v_sig);
    if not has_function_privilege('authenticated', v_sig, 'EXECUTE')
       or has_function_privilege('anon', v_sig, 'EXECUTE')
       or has_function_privilege('service_role', v_sig, 'EXECUTE') then
      raise exception 'activation_verification_failed: %', v_sig;
    end if;
  end loop;

  -- (3) Reopen, now that legacy writes cannot resume.
  update app_write_gate
     set authoritative_writes_active = true, completion_writes_paused = false, paused_at = null
   where id = 1;
  update phase3_cutover_state set stage = 'activated', activated_at = clock_timestamp(), updated_at = clock_timestamp() where id = 1;
  perform fn_phase3_log('activate', jsonb_build_object('cutoverAt', v_state.cutover_at));
  return fn_phase3_status();
end;
$$;

-- Recovery BEFORE activation only: return to legacy operation. Rows the
-- legacy bridges write after this are still 'current'; the next
-- fn_phase3_close_gate() captures a new boundary and the next
-- fn_phase3_backfill() records them as a new batch (earlier batches and
-- their captured originals are never touched again).
create or replace function fn_phase3_reopen_legacy()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_state record;
begin
  perform fn_phase3_default_lock_timeout();
  select * into v_state from phase3_cutover_state where id = 1 for update;
  if v_state.stage not in ('paused', 'backfilled') then
    raise exception 'precondition_failed: stage is %, reopen_legacy only applies to paused/backfilled', v_state.stage;
  end if;
  perform 1 from app_write_gate where id = 1 and not legacy_writes_retired and not authoritative_writes_active for update;
  if not found then raise exception 'precondition_failed: already activated'; end if;
  update app_write_gate set completion_writes_paused = false, paused_at = null where id = 1;
  update phase3_cutover_state set stage = 'restricted', updated_at = clock_timestamp() where id = 1;
  perform fn_phase3_log('reopen_legacy', jsonb_build_object('fromStage', v_state.stage, 'previousCutoverAt', v_state.cutover_at));
  return fn_phase3_status();
end;
$$;

-- -------------------------------------------------------------------------
-- 9. Privileges (exact signatures). Everything new is revoked from every
--    application role first — Supabase default privileges grant new
--    functions to anon/authenticated/service_role individually.
-- -------------------------------------------------------------------------

revoke execute on function fn_check_write_gate() from public, anon, authenticated, service_role;
revoke execute on function fn_check_authoritative_write_gate() from public, anon, authenticated, service_role;
revoke execute on function fn_js_whitespace_chars() from public, anon, authenticated, service_role;
revoke execute on function fn_js_normalize_whitespace(text) from public, anon, authenticated, service_role;
revoke execute on function fn_js_remove_punctuation(text) from public, anon, authenticated, service_role;
revoke execute on function fn_normalize_dictation_text(text, text) from public, anon, authenticated, service_role;
revoke execute on function fn_classify_dictation_error(text, text) from public, anon, authenticated, service_role;
revoke execute on function fn_round_progress(uuid) from public, anon, authenticated, service_role;
revoke execute on function fn_try_complete_round(uuid) from public, anon, authenticated, service_role;
revoke execute on function fn_js_has_content(text) from public, anon, authenticated, service_role;
revoke execute on function fn_validate_supplied_study_session(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke execute on function fn_attribute_study_session(uuid, text, uuid, text, uuid) from public, anon, authenticated, service_role;

-- Authoritative writers: dormant until fn_phase3_activate().
revoke execute on function fn_create_or_get_active_round(text, uuid, integer, numeric) from public, anon, authenticated, service_role;
revoke execute on function fn_update_resume_position(uuid, text, integer, numeric, uuid) from public, anon, authenticated, service_role;
revoke execute on function fn_restart_round(text, uuid) from public, anon, authenticated, service_role;
revoke execute on function fn_record_dictation_attempt(uuid, text, integer, uuid, text, text, uuid, uuid, smallint) from public, anon, authenticated, service_role;
revoke execute on function fn_record_shadowing_attempt(uuid, text, integer, uuid, numeric, uuid, uuid) from public, anon, authenticated, service_role;

-- Backend-only (prep release uses it before direct writes are removed).
revoke execute on function fn_persist_session_assessment(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function fn_persist_session_assessment(uuid, uuid, jsonb) to service_role;

-- Availability signal for the Phase 3 routes.
revoke execute on function fn_practice_write_status() from public, anon, authenticated, service_role;
grant execute on function fn_practice_write_status() to authenticated;

-- Operator-only.
revoke execute on function fn_phase3_log(text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function fn_phase3_default_lock_timeout() from public, anon, authenticated, service_role;
revoke execute on function fn_phase3_status() from public, anon, authenticated, service_role;
revoke execute on function fn_phase3_restrict_direct_writes() from public, anon, authenticated, service_role;
revoke execute on function fn_phase3_close_gate() from public, anon, authenticated, service_role;
revoke execute on function fn_phase3_backfill() from public, anon, authenticated, service_role;
revoke execute on function fn_phase3_activate() from public, anon, authenticated, service_role;
revoke execute on function fn_phase3_reopen_legacy() from public, anon, authenticated, service_role;

select fn_phase3_log('migration_037_applied');
