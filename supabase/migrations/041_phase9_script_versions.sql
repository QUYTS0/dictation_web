-- =====================================================
-- 041 — Phase 9: Script Versions (listing, preview data, retention,
--        size estimates; deletion specified but UNREACHABLE)
--
-- Builds on Phase 0 (020/021: content_fingerprint, is_current,
-- superseded_at, fn_publish_transcript_revision's lock → verify → retire →
-- promote) and Phase 1 (029: users.is_admin, the estimated_* columns).
-- Duplicate prevention already ships in 021 and is not changed here.
--
--   fn_transcript_retention        — internal: why a revision is kept, or
--                                     when it becomes a cleanup candidate
--   fn_refresh_transcript_size_estimate — internal: logical row-storage
--                                     estimate of one revision
--   fn_transcript_versions         — the Script Versions listing
--                                     (authenticated; refreshes stale
--                                     estimates lazily, ≥ 1 hour old)
--   fn_delete_transcript_revision  — fully specified, but NO role may
--                                     execute it (plan §6.9/§8.16: v1 gate)
--   five lookup indexes for the reference checks
--
-- No existing table, row, function or grant changes. Plan §5.7, §6.9,
-- §8.16, §10.7; operational notes in supabase/PHASE9_RUNBOOK.md.
-- =====================================================

-- -------------------------------------------------------------------------
-- 1. Lookup indexes for the reference checks (one revision at a time)
-- -------------------------------------------------------------------------

create index if not exists attempt_logs_transcript_idx on attempt_logs(transcript_id) where transcript_id is not null;
create index if not exists shadowing_attempts_transcript_idx on shadowing_attempts(transcript_id) where transcript_id is not null;
create index if not exists listening_progress_transcript_idx on listening_progress(transcript_id) where transcript_id is not null;
create index if not exists vocabulary_items_video_idx on vocabulary_items(video_id);
create index if not exists bookmarks_video_idx on bookmarks(video_id);

-- -------------------------------------------------------------------------
-- 2. Retention classification (plan §6.9)
-- -------------------------------------------------------------------------
--
-- PROTECTED (never a cleanup candidate) while any reason holds. Direct
-- references — every FK that points at the revision, for EVERY status:
--   current           is_current
--   processing        status = 'processing' (a job in flight)
--   practice_round    any learning_sessions.transcript_id (active,
--                     completed or abandoned — never only active)
--   attempts          any attempt_logs / shadowing_attempts.transcript_id
--   legacy_history    a round pinned to it holds legacy_unverified answers
--   listening         any listening_progress.transcript_id
--   legacy_listening  any pre-Phase-5 listening_sessions.transcript_id
-- These FKs are ON DELETE SET NULL / CASCADE, so a deletion would silently
-- detach (or remove) learning history — hence every one is a protection.
-- Indirect (no FK exists — coarse, honest):
--   saved_words       any vocabulary_items / bookmarks row for the video
-- Otherwise the grace period applies, anchored once at superseded_at (or
-- created_at for a revision never promoted): candidate only 30 days later.
-- Never age alone, never "keep the latest N".
create or replace function fn_transcript_retention(p_transcript_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (
    select * from transcripts where id = p_transcript_id
  ),
  r as (
    select array_remove(array[
      case when t.is_current then 'current' end,
      case when t.status = 'processing' then 'processing' end,
      case when exists (select 1 from learning_sessions s
                         where s.youtube_video_id = t.youtube_video_id and s.transcript_id = t.id) then 'practice_round' end,
      case when exists (select 1 from attempt_logs a where a.transcript_id = t.id)
             or exists (select 1 from shadowing_attempts sa where sa.transcript_id = t.id) then 'attempts' end,
      case when exists (select 1 from learning_sessions s join attempt_logs a on a.session_id = s.id
                         where s.youtube_video_id = t.youtube_video_id and s.transcript_id = t.id
                           and a.segment_identity_provenance = 'legacy_unverified') then 'legacy_history' end,
      case when exists (select 1 from listening_progress p where p.transcript_id = t.id) then 'listening' end,
      case when exists (select 1 from listening_sessions l
                         where l.youtube_video_id = t.youtube_video_id and l.transcript_id = t.id) then 'legacy_listening' end,
      case when exists (select 1 from vocabulary_items v where v.video_id = t.youtube_video_id)
             or exists (select 1 from bookmarks b where b.video_id = t.youtube_video_id) then 'saved_words' end
    ], null) as reasons,
    coalesce(t.superseded_at, t.created_at) + interval '30 days' as eligible_at
    from t
  )
  select case when not exists (select 1 from t) then null else jsonb_build_object(
    'reasons', to_jsonb(r.reasons),
    'protected', cardinality(r.reasons) > 0,
    -- When the grace period ends (only meaningful once nothing protects it).
    'eligibleAt', case when cardinality(r.reasons) = 0 then r.eligible_at end,
    'inGracePeriod', cardinality(r.reasons) = 0 and now() < r.eligible_at,
    -- A classification under the retention rules — NOT a statement that
    -- deletion is available (it is not, in v1).
    'cleanupCandidate', cardinality(r.reasons) = 0 and now() >= r.eligible_at
  ) end
  from r;
$$;

-- -------------------------------------------------------------------------
-- 3. Size estimates (plan §6.9) — logical row storage attributed to the
--    revision: its full text, its segment rows, its translation rows, its
--    vocabulary-highlight rows. Not index overhead, not on-disk compression,
--    never "bytes freed by deleting". Vocabulary audio/images and the
--    content-addressed audio cache are not owned by a revision; there is no
--    revision-owned file storage (files = 0).
-- -------------------------------------------------------------------------
create or replace function fn_refresh_transcript_size_estimate(p_transcript_id uuid)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  with sizes as (
    select coalesce(octet_length(t.full_text), 0)::bigint as text_bytes,
           (select coalesce(sum(pg_column_size(s.*)), 0) from transcript_segments s where s.transcript_id = t.id)::bigint as seg_bytes,
           (select coalesce(sum(pg_column_size(x.*)), 0) from transcript_translations x where x.transcript_id = t.id)::bigint as tr_bytes,
           (select coalesce(sum(pg_column_size(h.*)), 0) from transcript_vocab_highlights h where h.transcript_id = t.id)::bigint as hl_bytes
      from transcripts t where t.id = p_transcript_id
  )
  update transcripts t
     set estimated_text_bytes = sizes.text_bytes,
         estimated_segments_bytes = sizes.seg_bytes,
         estimated_translations_bytes = sizes.tr_bytes,
         estimated_highlights_bytes = sizes.hl_bytes,
         estimated_total_bytes = sizes.text_bytes + sizes.seg_bytes + sizes.tr_bytes + sizes.hl_bytes,
         size_estimated_at = now()
    from sizes
   where t.id = p_transcript_id;
$$;

-- -------------------------------------------------------------------------
-- 4. The Script Versions listing (authenticated)
-- -------------------------------------------------------------------------
--
-- Transcripts are shared per (video, language) and publicly readable, so
-- every signed-in viewer sees every revision — but only THEIR OWN round
-- association (yourRound), never another user's rounds or counts.
-- Retention reasons are generic labels, never counts. Stale or missing
-- size estimates (≥ 1 hour) are refreshed for this video's revisions only,
-- skipping any revision another transaction has locked (publication) —
-- that one keeps its previous estimate until the next open.
create or replace function fn_transcript_versions(p_youtube_video_id text, p_language text default 'en')
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_youtube_video_id is null or btrim(p_youtube_video_id) = '' or length(p_youtube_video_id) > 64
     or p_language is null or btrim(p_language) = '' or length(p_language) > 16 then
    raise exception 'invalid_payload';
  end if;

  for v_id in
    select id from transcripts
     where youtube_video_id = p_youtube_video_id and language = p_language
       and (size_estimated_at is null or size_estimated_at < now() - interval '1 hour')
     order by version
     limit 100
     for update skip locked
  loop
    perform fn_refresh_transcript_size_estimate(v_id);
  end loop;

  return jsonb_build_object(
    'videoId', p_youtube_video_id,
    'language', p_language,
    -- v1: physical deletion is disabled for every video (no EXECUTE grant
    -- on fn_delete_transcript_revision for any role).
    'deletionEnabled', false,
    'retentionGraceDays', 30,
    'revisions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'transcriptId', t.id,
        'version', t.version,
        'source', t.source,
        'status', t.status,
        'createdAt', t.created_at,
        'supersededAt', t.superseded_at,
        'isCurrent', t.is_current,
        'sentenceCount', (select count(*) from transcript_segments s where s.transcript_id = t.id),
        'yourRound', (
          select jsonb_build_object('roundId', s.id, 'status', s.status, 'roundNumber', s.round_number)
            from learning_sessions s
           where s.user_id = v_user and s.youtube_video_id = t.youtube_video_id and s.transcript_id = t.id
           order by (s.status = 'active') desc, s.started_at desc, s.id desc
           limit 1),
        'size', jsonb_build_object(
          'textBytes', t.estimated_text_bytes,
          'segmentsBytes', t.estimated_segments_bytes,
          'translationsBytes', t.estimated_translations_bytes,
          'highlightsBytes', t.estimated_highlights_bytes,
          'filesBytes', 0,
          'totalBytes', t.estimated_total_bytes,
          'estimatedAt', t.size_estimated_at),
        'retention', ret.r,
        -- Derived, never stored: the estimate only for an actual cleanup
        -- candidate, otherwise 0 (the retention reasons say why).
        'eligibleForRemovalBytes', case when (ret.r->>'cleanupCandidate')::boolean then coalesce(t.estimated_total_bytes, 0) else 0 end
      ) order by t.version desc, t.created_at desc)
      from transcripts t
      cross join lateral (select fn_transcript_retention(t.id) as r) ret
      where t.youtube_video_id = p_youtube_video_id and t.language = p_language), '[]'::jsonb)
  );
end;
$$;

-- -------------------------------------------------------------------------
-- 5. Deletion — fully specified, deliberately unreachable in v1
-- -------------------------------------------------------------------------
--
-- When a later, separate migration grants EXECUTE (plan §6.9's future-
-- enablement criteria), this is the contract:
--   * actor = auth.uid(), who must be users.is_admin (never a parameter);
--   * the target row is locked FOR UPDATE — the same row lock publication
--     takes on a fingerprint-matched candidate (021), so a reuse and a
--     deletion of the same revision serialize: deletion arriving second
--     sees it current and refuses; publication arriving second finds it
--     gone and inserts fresh content;
--   * every protection is re-checked under that lock (never the dialog's
--     snapshot). A direct reference → revision_now_referenced; saved
--     words for the video → revision_protected_saved_words; still in the
--     grace period → revision_in_grace_period. Nothing is changed then.
--   * otherwise the revision row is deleted; its segments, translations
--     and highlights cascade.
-- Known, documented gap (plan §6.9): vocabulary/bookmark inserts take no
-- lock shared with this function — the reason deletion stays disabled for
-- EVERY video in v1, enforced by the missing grant below.
create or replace function fn_delete_transcript_revision(p_transcript_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_row transcripts%rowtype;
  v_ret jsonb;
  v_reasons text[];
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not coalesce((select is_admin from users where id = v_user), false) then
    raise exception 'admin_required';
  end if;
  if p_transcript_id is null then raise exception 'invalid_payload'; end if;

  select * into v_row from transcripts where id = p_transcript_id for update;
  if not found then raise exception 'transcript_not_found'; end if;

  v_ret := fn_transcript_retention(p_transcript_id);
  v_reasons := array(select jsonb_array_elements_text(v_ret->'reasons'));
  if v_reasons && array['current', 'processing', 'practice_round', 'attempts', 'legacy_history', 'listening', 'legacy_listening'] then
    raise exception 'revision_now_referenced';
  end if;
  if 'saved_words' = any(v_reasons) then
    raise exception 'revision_protected_saved_words';
  end if;
  if not (v_ret->>'cleanupCandidate')::boolean then
    raise exception 'revision_in_grace_period';
  end if;

  delete from transcripts where id = p_transcript_id;
  return jsonb_build_object('deleted', true, 'transcriptId', p_transcript_id, 'version', v_row.version);
end;
$$;

-- -------------------------------------------------------------------------
-- 6. Privileges (exact signatures; PUBLIC's default EXECUTE revoked)
-- -------------------------------------------------------------------------

revoke all on function fn_transcript_retention(uuid) from public, anon, authenticated, service_role;
revoke all on function fn_refresh_transcript_size_estimate(uuid) from public, anon, authenticated, service_role;

revoke all on function fn_transcript_versions(text, text) from public, anon, service_role;
grant execute on function fn_transcript_versions(text, text) to authenticated;

-- THE v1 GATE: no application role — anon, authenticated (an is_admin
-- user's own client included) or service_role — may execute deletion. No
-- grant statement exists; enabling it is a separate, later migration.
revoke all on function fn_delete_transcript_revision(uuid) from public, anon, authenticated, service_role;
