-- =====================================================
-- Phase 0 — Atomic transcript-revision publication
--
-- Replaces transcript/generate/route.ts's old "update the same row in
-- place, delete its old segments, insert new ones" sequence with a single
-- atomic function: a partially-written transcript is never visible as
-- status='ready', and a previously-published revision's id/segments are
-- never mutated or deleted by a later regeneration.
--
-- See .claude/video-learning-management-plan.md, Phase 0 / §6.9 / §8.3.
-- =====================================================

create or replace function fn_publish_transcript_revision(
  p_youtube_video_id text,
  p_language text,
  p_source text,
  p_full_text text,
  p_segments jsonb,
  p_content_fingerprint text
) returns transcripts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match_id uuid;
  v_match transcripts%rowtype;
  v_reuse boolean := false;
  v_result transcripts%rowtype;
begin
  if p_youtube_video_id is null or p_youtube_video_id = '' then
    raise exception 'fn_publish_transcript_revision: youtube_video_id is required';
  end if;
  if p_language is null or p_language = '' then
    raise exception 'fn_publish_transcript_revision: language is required';
  end if;
  if p_source is null or p_source not in ('cache', 'ai', 'manual') then
    raise exception 'fn_publish_transcript_revision: source must be cache, ai, or manual';
  end if;
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
    raise exception 'fn_publish_transcript_revision: segments must be a non-empty array';
  end if;

  -- Serializes concurrent regenerations of the same (video, language) so
  -- two simultaneous "regenerate" calls collapse to one outcome instead of
  -- racing each other's retire/promote steps below.
  perform pg_advisory_xact_lock(hashtext(p_youtube_video_id || '::' || p_language));

  -- Only a non-null fingerprint can match -- a legacy row with a null
  -- content_fingerprint is never matched by `content_fingerprint = p_content_fingerprint`
  -- (null comparisons are never true in SQL), which is the documented,
  -- intentional behavior for pre-Phase-0 rows (see migration 020's comment).
  if p_content_fingerprint is not null then
    select id into v_match_id
    from transcripts
    where youtube_video_id = p_youtube_video_id
      and language = p_language
      and status = 'ready'
      and content_fingerprint = p_content_fingerprint
    limit 1;
  end if;

  if v_match_id is not null then
    -- Lock the candidate and revalidate it BEFORE acting on it -- it must
    -- still be a ready, matching row at the moment we commit to reusing it,
    -- not merely at the moment of the SELECT above.
    select * into v_match from transcripts where id = v_match_id and status = 'ready' for update;
    if found then
      v_reuse := true;
    end if;
  end if;

  if v_reuse then
    -- Retire the previous current revision BEFORE promoting the reused one
    -- -- never the reverse, since transcripts_one_current_idx forbids two
    -- is_current rows for the same (video, language) even transiently.
    update transcripts
    set is_current = false, superseded_at = now()
    where youtube_video_id = p_youtube_video_id
      and language = p_language
      and is_current
      and id <> v_match.id;

    update transcripts
    set is_current = true, superseded_at = null, updated_at = now()
    where id = v_match.id
    returning * into v_result;
  else
    -- No fingerprint match, or the matched row was no longer ready/present
    -- at lock time -- either way, fall through to publishing fresh content.
    update transcripts
    set is_current = false, superseded_at = now()
    where youtube_video_id = p_youtube_video_id
      and language = p_language
      and is_current;

    insert into transcripts (
      youtube_video_id, language, source, status, full_text,
      content_fingerprint, is_current, version
    )
    values (
      p_youtube_video_id, p_language, p_source, 'ready', p_full_text,
      p_content_fingerprint, true,
      coalesce(
        (select max(version) from transcripts
         where youtube_video_id = p_youtube_video_id and language = p_language),
        0
      ) + 1
    )
    returning * into v_result;

    insert into transcript_segments (
      transcript_id, segment_index, start_sec, end_sec, duration_sec, text_raw, text_normalized
    )
    select
      v_result.id,
      (seg->>'segmentIndex')::int,
      (seg->>'start')::numeric,
      (seg->>'end')::numeric,
      (seg->>'end')::numeric - (seg->>'start')::numeric,
      seg->>'text',
      seg->>'textNormalized'
    from jsonb_array_elements(p_segments) as seg;
  end if;

  return v_result;
end;
$$;

-- Backend-only: publication is a shared-content operation with no per-user
-- actor to check, so it must never be reachable directly from a browser,
-- even an authenticated one. `anon` is named explicitly, not just `public`
-- -- Supabase's default per-schema privileges grant `anon` its own separate
-- EXECUTE on every newly created function, which a PUBLIC-only revoke does
-- not remove.
revoke execute on function fn_publish_transcript_revision(text, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function fn_publish_transcript_revision(text, text, text, text, jsonb, text)
  to service_role;
