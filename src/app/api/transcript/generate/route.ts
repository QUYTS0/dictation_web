import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeText } from "@/lib/utils/text";
import { computeTranscriptFingerprint } from "@/lib/utils/transcriptFingerprint";
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

    // The video's current, ready revision (Phase 0 — is_current is the one
    // authoritative pointer to it; decoupled from "most recently updated",
    // which is no longer a safe proxy now that regeneration publishes a new
    // row instead of mutating the existing one in place).
    const { data: currentReady, error: currentReadyError } = await supabase
      .from("transcripts")
      .select("id, status")
      .eq("youtube_video_id", videoId)
      .eq("language", language)
      .eq("is_current", true)
      .maybeSingle();

    if (currentReadyError) {
      console.error("[transcript generate] current-revision query error:", currentReadyError);
      return NextResponse.json({ error: "Failed to inspect transcript state" }, { status: 500 });
    }

    // Only used as a failure-bookkeeping placeholder (see reportFetchFailure
    // below) when no current ready revision exists — never used to decide
    // reuse, and never mutated in place on a successful publish. Historical
    // revisions are never deleted or merged by this route.
    const { data: mostRecentAnyStatus, error: mostRecentAnyStatusError } = await supabase
      .from("transcripts")
      .select("id, status")
      .eq("youtube_video_id", videoId)
      .eq("language", language)
      .order("updated_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (mostRecentAnyStatusError) {
      console.error("[transcript generate] most-recent transcript query error:", mostRecentAnyStatusError);
      return NextResponse.json({ error: "Failed to inspect transcript state" }, { status: 500 });
    }

    const failurePlaceholderCandidate = currentReady ?? mostRecentAnyStatus ?? null;

    if (!force && currentReady) {
      const { count: segmentCount, error: segmentCountError } = await supabase
        .from("transcript_segments")
        .select("id", { count: "exact", head: true })
        .eq("transcript_id", currentReady.id);
      if (segmentCountError) {
        console.error("[transcript generate] ready transcript segment count error:", segmentCountError);
        return NextResponse.json({ error: "Failed to validate ready transcript" }, { status: 500 });
      }
      if ((segmentCount ?? 0) > 0) {
        console.log(
          `[transcript generate] reusing current transcript ${currentReady.id} (segments=${segmentCount})`
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
        return NextResponse.json({ transcriptId: currentReady.id, status: currentReady.status });
      }
    }

    // A previously-ready current transcript is valuable — resolve the
    // replacement segments first and only publish once they're confirmed
    // good, so a failed regenerate can't wipe out a script that was
    // working (fn_publish_transcript_revision never touches the previous
    // current revision unless a new one is actually being published).
    const hasWorkingTranscriptToPreserve = !!currentReady;

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
            failurePlaceholderCandidate,
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
            failurePlaceholderCandidate,
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
            failurePlaceholderCandidate,
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

    // We now have confirmed-good segments — publish them as a new revision,
    // atomically, via fn_publish_transcript_revision (Phase 0). This never
    // mutates or deletes a previously-published revision's row or segments
    // — regeneration always either reuses an existing ready revision whose
    // content-fingerprint matches, or inserts a brand-new transcript row.
    // Because publication is one transaction, a failure here leaves
    // whatever was already published (including the previous current
    // revision, if any) completely untouched — there is no intermediate
    // "processing" row to clean up on failure, unlike the old
    // update-in-place flow.
    const fullText = resolvedSegments.map((s) => s.text).join(" ");
    const contentFingerprint = computeTranscriptFingerprint(resolvedSegments);
    const segmentsForPublish = resolvedSegments.map((seg) => ({
      segmentIndex: seg.segmentIndex,
      start: seg.start,
      end: seg.end,
      text: seg.text,
      textNormalized: normalizeText(seg.text, "relaxed"),
    }));

    console.log(
      `[transcript generate] publishing ${segmentsForPublish.length} segments for video ${videoId} (fingerprint=${contentFingerprint.slice(0, 12)}…)`
    );

    const { data: published, error: publishError } = await supabase.rpc("fn_publish_transcript_revision", {
      p_youtube_video_id: videoId,
      p_language: language,
      p_source: source,
      p_full_text: fullText,
      p_segments: segmentsForPublish,
      p_content_fingerprint: contentFingerprint,
    });

    if (publishError || !published) {
      console.error("[transcript generate] publish error:", publishError);
      // Nothing was written — fn_publish_transcript_revision is one
      // transaction, so a failure here never leaves a partially-written
      // row and never touches the previous current revision.
      return NextResponse.json({ error: "Failed to publish transcript revision" }, { status: 500 });
    }

    const transcriptId: string = published.id;

    console.log(
      `[transcript generate] published transcript ${transcriptId} (version=${published.version}) for video ${videoId}`
    );

    const outcomeLabel: TranscriptFetchOutcome = fallbackUsed ? "fallback_success" : "success";
    recordTranscriptFetchEvent({
      videoIdHash: hashVideoId(videoId),
      provider: metricsProvider,
      outcome: outcomeLabel,
      attemptCount,
      fallbackUsed,
      durationMs: Date.now() - requestStartedAt,
      segmentCount: segmentsForPublish.length,
      cacheHit: false,
      lockContended,
      cooldownHit,
    });

    return NextResponse.json({
      transcriptId,
      status: "ready",
      segmentCount: segmentsForPublish.length,
    });
  } catch (err) {
    console.error("[transcript generate] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
