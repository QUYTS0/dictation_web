import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeText } from "@/lib/utils/text";
import { checkRateLimit } from "@/lib/rateLimit";
import { mergeIntoSentences } from "@/lib/utils/segment";
import { generateEnglishTranscript, toCueItems } from "@/lib/youtubeCaptions/orchestrator";
import { validateManualSegments, validateMergedSegments } from "@/lib/youtubeCaptions/validation";
import { httpStatusForCode } from "@/lib/youtubeCaptions/errors";
import { acquireTranscriptLock } from "@/lib/youtubeCaptions/lock";
import { getCooldown, setCooldown, clearCooldown, resolveCooldownStatus } from "@/lib/youtubeCaptions/cooldown";
import { recordTranscriptFetchEvent, hashVideoId, type TranscriptFetchOutcome } from "@/lib/youtubeCaptions/metrics";
import { LOCK_CONFIG, ROUTE_DEADLINE_MS } from "@/lib/youtubeCaptions/config";
import type { TranscriptProviderName } from "@/lib/youtubeCaptions/types";

export const maxDuration = 60;

interface GenerateRequest {
  videoId: string;
  language?: string;
  /**
   * When true, mark any existing transcript (including "ready" ones) as failed
   * so a fresh fetch is performed. Use this when the cached transcript has
   * incorrect timestamps or mismatched text/audio. Also bypasses an active
   * fetch cooldown for this video (but never the single-flight lock — a
   * generation already in progress elsewhere still wins).
   */
  force?: boolean;
  /** Optional pre-built segments (e.g., from YouTube captions, manual paste, .srt/.vtt upload) */
  segments?: Array<{
    segmentIndex: number;
    start: number;
    end: number;
    text: string;
  }>;
  /** Only affects metrics labeling — which manual import path produced `segments`. */
  importSource?: "manual" | "srt" | "vtt";
}

interface ResolvedSegment {
  segmentIndex: number;
  start: number;
  end: number;
  text: string;
}

/**
 * Records a caption-fetch failure. If a previously "ready" transcript exists
 * for this video, it's left completely untouched — a failed regenerate must
 * never leave the video with no usable script at all. Otherwise (nothing
 * working to lose) the transcript is marked "failed" so the client's GET
 * polling settles instead of treating it as perpetually "processing".
 */
async function reportFetchFailure(
  supabase: SupabaseClient,
  canonicalTranscript: { id: string } | null,
  hasWorkingTranscriptToPreserve: boolean,
  videoId: string,
  language: string,
  userMessage: string,
  statusCode = 422,
  extra: {
    code?: string;
    retryAfterMs?: number;
    retryAt?: string;
    previousErrorCode?: string;
  } = {}
) {
  if (hasWorkingTranscriptToPreserve) {
    return NextResponse.json({ status: "ready", error: userMessage, ...extra }, { status: statusCode });
  }

  if (canonicalTranscript) {
    await supabase.from("transcripts").update({ status: "failed" }).eq("id", canonicalTranscript.id);
    return NextResponse.json(
      { transcriptId: canonicalTranscript.id, status: "failed", error: userMessage, ...extra },
      { status: statusCode }
    );
  }

  const { data: failedTranscript } = await supabase
    .from("transcripts")
    .insert({ youtube_video_id: videoId, language, source: "cache", status: "failed", version: 1 })
    .select("id")
    .single();

  return NextResponse.json(
    { transcriptId: failedTranscript?.id, status: "failed", error: userMessage, ...extra },
    { status: statusCode }
  );
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "transcript/generate", {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitResponse) return rateLimitResponse;

  const requestStartedAt = Date.now();

  try {
    const body: GenerateRequest = await request.json();
    const { videoId, language = "en", segments: providedSegments, force = false, importSource } = body;

    if (!videoId || typeof videoId !== "string") {
      return NextResponse.json({ error: "videoId is required" }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Ensure the video record exists
    await supabase
      .from("videos")
      .upsert({ youtube_video_id: videoId }, { onConflict: "youtube_video_id" });

    const { data: existingTranscripts, error: existingTranscriptsError } = await supabase
      .from("transcripts")
      .select("id, status, updated_at, created_at")
      .eq("youtube_video_id", videoId)
      .eq("language", language)
      .order("updated_at", { ascending: false })
      .order("created_at", { ascending: false });

    if (existingTranscriptsError) {
      console.error("[transcript generate] existing transcript query error:", existingTranscriptsError);
      return NextResponse.json({ error: "Failed to inspect transcript state" }, { status: 500 });
    }

    const canonicalTranscript = existingTranscripts?.[0] ?? null;
    const duplicateTranscriptIds = (existingTranscripts ?? []).slice(1).map((item) => item.id);

    if (duplicateTranscriptIds.length > 0) {
      const { error: duplicateDeleteError } = await supabase
        .from("transcripts")
        .delete()
        .in("id", duplicateTranscriptIds);
      if (duplicateDeleteError) {
        console.error("[transcript generate] duplicate cleanup error:", duplicateDeleteError);
        return NextResponse.json({ error: "Failed to cleanup duplicate transcripts" }, { status: 500 });
      }
    }

    if (!force && canonicalTranscript?.status === "ready") {
      const { count: segmentCount, error: segmentCountError } = await supabase
        .from("transcript_segments")
        .select("id", { count: "exact", head: true })
        .eq("transcript_id", canonicalTranscript.id);
      if (segmentCountError) {
        console.error("[transcript generate] ready transcript segment count error:", segmentCountError);
        return NextResponse.json({ error: "Failed to validate ready transcript" }, { status: 500 });
      }
      if ((segmentCount ?? 0) > 0) {
        console.log(
          `[transcript generate] reusing ready transcript ${canonicalTranscript.id} (segments=${segmentCount})`
        );
        recordTranscriptFetchEvent({
          videoIdHash: hashVideoId(videoId),
          provider: "youtube-transcript",
          outcome: "success",
          attemptCount: 0,
          fallbackUsed: false,
          durationMs: Date.now() - requestStartedAt,
          cacheHit: true,
          lockContended: false,
          cooldownHit: false,
        });
        return NextResponse.json({ transcriptId: canonicalTranscript.id, status: canonicalTranscript.status });
      }
    }

    // A previously-ready transcript is valuable — resolve the replacement
    // segments first and only touch the DB once they're confirmed good, so a
    // failed regenerate can't wipe out a script that was working.
    const hasWorkingTranscriptToPreserve = canonicalTranscript?.status === "ready";

    let resolvedSegments: ResolvedSegment[];
    let source: "manual" | "cache";
    let metricsProvider: TranscriptProviderName = "manual";
    let attemptCount = 0;
    let fallbackUsed = false;
    let lockContended = false;
    // Always false by the time the success path's final metrics event is
    // recorded below — an active cooldown returns a response earlier in
    // this function and never reaches persistence. Kept as an explicit
    // field (rather than a literal) so the event shape stays self-describing.
    const cooldownHit = false;

    if (providedSegments && providedSegments.length > 0) {
      metricsProvider = importSource ?? "manual";
      // Defense in depth — a client-provided segmentIndex isn't trusted;
      // re-derived from array position before validating/persisting.
      const reindexed = providedSegments.map((s, i) => ({ ...s, segmentIndex: i }));
      const manualValidation = validateManualSegments(reindexed);
      if (!manualValidation.ok) {
        recordTranscriptFetchEvent({
          videoIdHash: hashVideoId(videoId),
          provider: metricsProvider,
          outcome: "failure",
          errorCode: manualValidation.failure.code,
          attemptCount: 1,
          fallbackUsed: false,
          durationMs: Date.now() - requestStartedAt,
          cacheHit: false,
          lockContended: false,
          cooldownHit: false,
        });
        return NextResponse.json({ error: manualValidation.failure.message, code: manualValidation.failure.code }, { status: 422 });
      }
      resolvedSegments = reindexed;
      source = "manual";
      attemptCount = 1;
    } else {
      // ---- Automatic path: cooldown -> single-flight lock -> providers ----
      if (!force) {
        const cooldownState = await getCooldown(videoId, language);
        const cooldownStatus = resolveCooldownStatus(cooldownState);
        if (cooldownStatus.active) {
          recordTranscriptFetchEvent({
            videoIdHash: hashVideoId(videoId),
            provider: "youtube-transcript",
            outcome: "failure",
            errorCode: "FETCH_COOLDOWN",
            attemptCount: 0,
            fallbackUsed: false,
            durationMs: Date.now() - requestStartedAt,
            cacheHit: false,
            lockContended: false,
            cooldownHit: true,
          });
          return reportFetchFailure(
            supabase,
            canonicalTranscript,
            hasWorkingTranscriptToPreserve,
            videoId,
            language,
            "Automatic transcript access is temporarily unavailable for this video. Please try again shortly, or paste/upload a transcript.",
            503,
            {
              code: "FETCH_COOLDOWN",
              retryAfterMs: cooldownStatus.retryAfterMs,
              retryAt: cooldownStatus.retryAt,
              previousErrorCode: cooldownStatus.previousErrorCode,
            }
          );
        }
      }

      const lock = await acquireTranscriptLock(videoId, language);
      if (!lock) {
        lockContended = true;
        recordTranscriptFetchEvent({
          videoIdHash: hashVideoId(videoId),
          provider: "youtube-transcript",
          outcome: "failure",
          errorCode: "GENERATION_IN_PROGRESS",
          attemptCount: 0,
          fallbackUsed: false,
          durationMs: Date.now() - requestStartedAt,
          cacheHit: false,
          lockContended: true,
          cooldownHit: false,
        });
        return NextResponse.json(
          { status: "processing", code: "GENERATION_IN_PROGRESS", retryAfterMs: LOCK_CONFIG.contendedRetryAfterMs },
          { status: 202 }
        );
      }

      try {
        const deadlineAt = requestStartedAt + ROUTE_DEADLINE_MS;
        const outcome = await generateEnglishTranscript(videoId, { deadlineAt, language });
        attemptCount = outcome.attemptCount;
        fallbackUsed = outcome.fallbackUsed;
        metricsProvider = outcome.ok ? outcome.result.provider : fallbackUsed ? "innertube-raw" : "youtube-transcript";

        if (!outcome.ok) {
          await setCooldown(videoId, language, outcome.error.code, outcome.error.retryAfterMs);
          recordTranscriptFetchEvent({
            videoIdHash: hashVideoId(videoId),
            provider: metricsProvider,
            outcome: "failure",
            errorCode: outcome.error.code,
            attemptCount,
            fallbackUsed,
            durationMs: Date.now() - requestStartedAt,
            cacheHit: false,
            lockContended: false,
            cooldownHit: false,
          });
          console.warn(
            `[transcript generate] automatic fetch failed for ${videoId} (${outcome.error.code}, fallbackUsed=${fallbackUsed}): ${outcome.error.message}`
          );
          return reportFetchFailure(
            supabase,
            canonicalTranscript,
            hasWorkingTranscriptToPreserve,
            videoId,
            language,
            outcome.error.toSafeMessage(),
            httpStatusForCode(outcome.error.code),
            { code: outcome.error.code }
          );
        }

        const merged = mergeIntoSentences(toCueItems(outcome.result.cues));
        const mergedForValidation = merged.map((seg, i) => ({
          segmentIndex: i,
          start: seg.start,
          end: seg.start + seg.duration,
          text: seg.text,
        }));
        const mergedValidation = validateMergedSegments(mergedForValidation);
        if (!mergedValidation.ok) {
          recordTranscriptFetchEvent({
            videoIdHash: hashVideoId(videoId),
            provider: metricsProvider,
            outcome: "failure",
            errorCode: mergedValidation.failure.code,
            attemptCount,
            fallbackUsed,
            durationMs: Date.now() - requestStartedAt,
            cueCount: outcome.result.cues.length,
            cacheHit: false,
            lockContended: false,
            cooldownHit: false,
          });
          return reportFetchFailure(
            supabase,
            canonicalTranscript,
            hasWorkingTranscriptToPreserve,
            videoId,
            language,
            "Could not extract usable segments from captions.",
            422,
            { code: mergedValidation.failure.code }
          );
        }

        resolvedSegments = mergedForValidation;
        source = "cache";
        await clearCooldown(videoId, language);
      } finally {
        await lock.release();
      }
    }

    // We now have confirmed-good segments — safe to replace whatever existed.
    let transcriptId: string;
    if (canonicalTranscript) {
      const { error: canonicalUpdateError } = await supabase
        .from("transcripts")
        .update({
          status: "processing",
          source,
          full_text: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", canonicalTranscript.id);
      if (canonicalUpdateError) {
        console.error("[transcript generate] canonical transcript update error:", canonicalUpdateError);
        return NextResponse.json({ error: "Failed to refresh transcript record" }, { status: 500 });
      }

      const { error: previousSegmentDeleteError } = await supabase
        .from("transcript_segments")
        .delete()
        .eq("transcript_id", canonicalTranscript.id);
      if (previousSegmentDeleteError) {
        console.error("[transcript generate] previous segment cleanup error:", previousSegmentDeleteError);
        return NextResponse.json({ error: "Failed to reset transcript segments" }, { status: 500 });
      }

      // Translations and vocab highlights are cached by (transcript_id,
      // segment_index) — since the transcript row is being reused, stale
      // rows here would otherwise get replayed against the new segments'
      // unrelated text just because the index happens to match.
      const { error: previousTranslationDeleteError } = await supabase
        .from("transcript_translations")
        .delete()
        .eq("transcript_id", canonicalTranscript.id);
      if (previousTranslationDeleteError) {
        console.error("[transcript generate] previous translation cleanup error:", previousTranslationDeleteError);
        return NextResponse.json({ error: "Failed to reset transcript translations" }, { status: 500 });
      }

      const { error: previousVocabHighlightDeleteError } = await supabase
        .from("transcript_vocab_highlights")
        .delete()
        .eq("transcript_id", canonicalTranscript.id);
      if (previousVocabHighlightDeleteError) {
        console.error("[transcript generate] previous vocab highlight cleanup error:", previousVocabHighlightDeleteError);
        return NextResponse.json({ error: "Failed to reset vocab highlights" }, { status: 500 });
      }

      transcriptId = canonicalTranscript.id;
    } else {
      const { data: transcript, error: tError } = await supabase
        .from("transcripts")
        .insert({
          youtube_video_id: videoId,
          language,
          source,
          status: "processing",
          version: 1,
        })
        .select("id")
        .single();

      if (tError || !transcript) {
        console.error("[transcript generate] insert error:", tError);
        return NextResponse.json({ error: "Failed to create transcript record" }, { status: 500 });
      }
      transcriptId = transcript.id;
    }

    console.log(
      `[transcript generate] writing ${resolvedSegments.length} segments to transcript ${transcriptId} for video ${videoId}`
    );

    const rows = resolvedSegments.map((seg) => ({
      transcript_id: transcriptId,
      segment_index: seg.segmentIndex,
      start_sec: seg.start,
      end_sec: seg.end,
      duration_sec: seg.end - seg.start,
      text_raw: seg.text,
      text_normalized: normalizeText(seg.text, "relaxed"),
    }));

    const { error: insertError } = await supabase
      .from("transcript_segments")
      .insert(rows);

    if (insertError) {
      console.error("[transcript generate] segment insert error:", insertError);
      await supabase
        .from("transcripts")
        .update({ status: "failed" })
        .eq("id", transcriptId);
      return NextResponse.json({ error: "Failed to store segments" }, { status: 500 });
    }

    const fullText = resolvedSegments.map((s) => s.text).join(" ");
    const { error: updateError } = await supabase
      .from("transcripts")
      .update({ status: "ready", full_text: fullText })
      .eq("id", transcriptId);

    if (updateError) {
      console.error("[transcript generate] status update error:", updateError);
      // Attempt to mark as failed so the client doesn't poll forever
      await supabase.from("transcripts").update({ status: "failed" }).eq("id", transcriptId);
      return NextResponse.json({ error: "Failed to finalize transcript" }, { status: 500 });
    }

    console.log(
      `[transcript generate] stored ${rows.length} segments for transcript ${transcriptId}`
    );

    const outcomeLabel: TranscriptFetchOutcome = fallbackUsed ? "fallback_success" : "success";
    recordTranscriptFetchEvent({
      videoIdHash: hashVideoId(videoId),
      provider: metricsProvider,
      outcome: outcomeLabel,
      attemptCount,
      fallbackUsed,
      durationMs: Date.now() - requestStartedAt,
      segmentCount: rows.length,
      cacheHit: false,
      lockContended,
      cooldownHit,
    });

    return NextResponse.json({
      transcriptId,
      status: "ready",
      segmentCount: rows.length,
    });
  } catch (err) {
    console.error("[transcript generate] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
