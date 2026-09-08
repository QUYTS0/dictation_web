import { NextRequest, NextResponse } from "next/server";
import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeText } from "@/lib/utils/text";
import { checkRateLimit } from "@/lib/rateLimit";
import { mergeIntoSentences } from "@/lib/utils/segment";

const TRANSIENT_RETRY_DELAY_MS = 1000;

/**
 * youtube-transcript swallows all detail about *why* it failed: its InnerTube
 * call silently returns undefined on any error, and its webpage-scrape
 * fallback only ever surfaces one of a few generic exceptions. In particular
 * "captions disabled" fires whenever the scraped page's player response has
 * no caption tracks — which is indistinguishable, from the outside, between
 * a genuinely caption-less video and YouTube serving a bot-limited response
 * to a suspected datacenter/non-browser IP. This wraps the library's fetch
 * (it accepts a custom one via TranscriptConfig.fetch) purely to log what
 * each outbound call actually returned, so a failure is diagnosable from
 * Vercel logs instead of being a black box.
 */
function createDiagnosticFetch(videoId: string): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    try {
      if (url.includes("/youtubei/v1/player")) {
        const json = await response.clone().json();
        const tracks = json?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        console.log(
          `[transcript generate] diag innertube ${videoId}: httpStatus=${response.status} ` +
          `playabilityStatus=${json?.playabilityStatus?.status ?? "?"} ` +
          `captionTracks=${Array.isArray(tracks) ? tracks.length : "none"}`
        );
      } else if (url.includes("youtube.com/watch")) {
        const text = await response.clone().text();
        const statusMatch = text.match(/"playabilityStatus":\s*\{\s*"status":\s*"([^"]+)"/);
        console.log(
          `[transcript generate] diag webpage ${videoId}: httpStatus=${response.status} bodyLen=${text.length} ` +
          `recaptcha=${text.includes('class="g-recaptcha"')} ` +
          `hasPlayability=${text.includes('"playabilityStatus":')} ` +
          `playabilityStatus=${statusMatch?.[1] ?? "?"} ` +
          `hasCaptionTracks=${text.includes('"captionTracks"')}`
        );
      }
    } catch (diagErr) {
      console.log(`[transcript generate] diag fetch logging failed for ${videoId}: ${String(diagErr)}`);
    }
    return response;
  };
}

/**
 * Retries once on errors that don't definitively mean "this video has no
 * captions" (e.g. YouTube's rate-limit/captcha response, or a network blip) —
 * without this, a single transient hiccup permanently stamps the transcript
 * "failed" and nothing ever retries it (GET only re-triggers generation for
 * "processing", not "failed").
 */
async function fetchTranscriptWithRetry(videoId: string, language: string) {
  const config = { lang: language, fetch: createDiagnosticFetch(videoId) };
  try {
    return await YoutubeTranscript.fetchTranscript(videoId, config);
  } catch (err) {
    const isPermanent =
      err instanceof YoutubeTranscriptDisabledError ||
      err instanceof YoutubeTranscriptNotAvailableError ||
      err instanceof YoutubeTranscriptNotAvailableLanguageError ||
      err instanceof YoutubeTranscriptVideoUnavailableError;
    if (isPermanent) throw err;

    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[transcript generate] transient caption fetch error for ${videoId}, retrying once: ${errMsg}`
    );
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
    return await YoutubeTranscript.fetchTranscript(videoId, config);
  }
}

interface GenerateRequest {
  videoId: string;
  language?: string;
  /**
   * When true, mark any existing transcript (including "ready" ones) as failed
   * so a fresh fetch is performed. Use this when the cached transcript has
   * incorrect timestamps or mismatched text/audio.
   */
  force?: boolean;
  /** Optional pre-built segments (e.g., from YouTube captions) */
  segments?: Array<{
    segmentIndex: number;
    start: number;
    end: number;
    text: string;
  }>;
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
  statusCode = 422
) {
  if (hasWorkingTranscriptToPreserve) {
    return NextResponse.json({ status: "ready", error: userMessage }, { status: statusCode });
  }

  if (canonicalTranscript) {
    await supabase.from("transcripts").update({ status: "failed" }).eq("id", canonicalTranscript.id);
    return NextResponse.json(
      { transcriptId: canonicalTranscript.id, status: "failed", error: userMessage },
      { status: statusCode }
    );
  }

  const { data: failedTranscript } = await supabase
    .from("transcripts")
    .insert({ youtube_video_id: videoId, language, source: "cache", status: "failed", version: 1 })
    .select("id")
    .single();

  return NextResponse.json(
    { transcriptId: failedTranscript?.id, status: "failed", error: userMessage },
    { status: statusCode }
  );
}

/**
 * Classifies a caption-fetch failure into a stable (logTag, userMessage,
 * statusCode) triple using the actual error class thrown by the
 * youtube-transcript library, instead of fragile substring matching on the
 * message text. A rate-limit/CAPTCHA block from YouTube (transient, affects
 * every video) must never be reported to the user identically to a video
 * that genuinely has no captions (permanent, video-specific) — conflating
 * the two hid a systemic scraper block behind a "captions are disabled"
 * message that pointed at the wrong cause.
 */
function classifyCaptionFetchError(
  err: unknown,
  language: string
): { logTag: string; userMessage: string; statusCode: number } {
  if (err instanceof YoutubeTranscriptTooManyRequestError) {
    return {
      logTag: "rate_limited",
      userMessage:
        "YouTube is temporarily blocking automated caption requests from our server. Please try again in a few minutes.",
      statusCode: 503,
    };
  }
  if (err instanceof YoutubeTranscriptVideoUnavailableError) {
    return {
      logTag: "video_unavailable",
      userMessage: "This video is unavailable (private, deleted, or restricted in some regions).",
      statusCode: 422,
    };
  }
  if (err instanceof YoutubeTranscriptNotAvailableLanguageError) {
    return {
      logTag: "language_unavailable",
      userMessage: `No ${language} captions available. Try a video with English captions enabled.`,
      statusCode: 422,
    };
  }
  if (err instanceof YoutubeTranscriptDisabledError || err instanceof YoutubeTranscriptNotAvailableError) {
    return {
      logTag: "captions_disabled",
      userMessage: "Captions are disabled for this video. Please choose a video with captions enabled.",
      statusCode: 422,
    };
  }
  return {
    logTag: "unknown",
    userMessage: "Captions are disabled for this video. Please choose a video with captions enabled.",
    statusCode: 422,
  };
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "transcript/generate", {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body: GenerateRequest = await request.json();
    const { videoId, language = "en", segments: providedSegments, force = false } = body;

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
        return NextResponse.json({ transcriptId: canonicalTranscript.id, status: canonicalTranscript.status });
      }
    }

    // A previously-ready transcript is valuable — resolve the replacement
    // segments first and only touch the DB once they're confirmed good, so a
    // failed regenerate can't wipe out a script that was working.
    const hasWorkingTranscriptToPreserve = canonicalTranscript?.status === "ready";

    let resolvedSegments: ResolvedSegment[];
    let source: "manual" | "cache";

    if (providedSegments && providedSegments.length > 0) {
      resolvedSegments = providedSegments;
      source = "manual";
    } else {
      let ytItems;
      try {
        ytItems = await fetchTranscriptWithRetry(videoId, language);
      } catch (captionErr) {
        // Expected/handled condition (no captions, or disabled) — the caller
        // falls back to the manual-paste UI, so this isn't a server error.
        // Log a concise line instead of the full stack trace.
        const errMsg = captionErr instanceof Error ? captionErr.message : String(captionErr);
        const { logTag, userMessage, statusCode } = classifyCaptionFetchError(captionErr, language);
        console.warn(
          `[transcript generate] caption fetch unavailable for ${videoId} (${logTag}): ${errMsg}`
        );
        return reportFetchFailure(
          supabase,
          canonicalTranscript,
          hasWorkingTranscriptToPreserve,
          videoId,
          language,
          userMessage,
          statusCode
        );
      }

      if (!ytItems || ytItems.length === 0) {
        return reportFetchFailure(
          supabase,
          canonicalTranscript,
          hasWorkingTranscriptToPreserve,
          videoId,
          language,
          "No captions found for this video."
        );
      }

      // Merge very short cue lines into sentence-level segments
      const merged = mergeIntoSentences(ytItems);

      if (merged.length === 0) {
        console.error(
          `[transcript generate] mergeIntoSentences produced 0 segments from ${ytItems.length} cues` +
          ` (cue texts may be empty or unit detection may have failed)`
        );
        return reportFetchFailure(
          supabase,
          canonicalTranscript,
          hasWorkingTranscriptToPreserve,
          videoId,
          language,
          "Could not extract segments from captions."
        );
      }

      resolvedSegments = merged.map((seg, i) => ({
        segmentIndex: i,
        start: seg.start,
        end: seg.start + seg.duration,
        text: seg.text,
      }));
      source = "cache";
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
