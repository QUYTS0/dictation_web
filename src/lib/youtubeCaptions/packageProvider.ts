// =====================================================
// Wraps the `youtube-transcript` npm package (still the first English
// provider tried) with:
//   - a diagnostic fetch that logs only safe, structured metadata (never
//     full response bodies) about what InnerTube/the webpage scrape
//     actually returned, so a failure is diagnosable from server logs
//   - classification of the package's own error classes into
//     TranscriptFetchError, so the orchestrator's fallback matrix can make
//     a typed decision instead of matching on message strings
// =====================================================

import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
  type TranscriptResponse as PackageCue,
} from "youtube-transcript";
import { normalizeCues } from "@/lib/utils/segment";
import type { CaptionCue, TranscriptProviderResult } from "./types";
import { TranscriptFetchError } from "./errors";
import { PLAYABILITY_BOT_BLOCK_STATUSES } from "./innerTubeClient";

interface DiagnosticCapture {
  /** First playabilityStatus seen across either the InnerTube or webpage
   *  request this call makes — read by fetchViaPackage after the package
   *  call settles, so a LOGIN_REQUIRED-style response (bot-block evidence,
   *  not "no captions") can be reclassified before the fallback matrix
   *  decides whether to try the second provider. */
  playabilityStatus?: string;
}

function createDiagnosticFetch(videoId: string, capture: DiagnosticCapture): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    try {
      if (url.includes("/youtubei/v1/player")) {
        const json = await response.clone().json();
        const tracks = json?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        const playabilityStatus: string | undefined = json?.playabilityStatus?.status;
        capture.playabilityStatus ??= playabilityStatus;
        console.log(
          `[packageProvider] innertube videoId=${videoId} httpStatus=${response.status} ` +
            `playabilityStatus=${playabilityStatus ?? "?"} ` +
            `captionTrackCount=${Array.isArray(tracks) ? tracks.length : 0}`
        );
      } else if (url.includes("youtube.com/watch")) {
        // Only safe, structural signals are extracted — the page body itself
        // (which could be large and is never useful beyond these booleans)
        // is never logged.
        const text = await response.clone().text();
        const statusMatch = text.match(/"playabilityStatus":\s*\{\s*"status":\s*"([^"]+)"/);
        capture.playabilityStatus ??= statusMatch?.[1];
        console.log(
          `[packageProvider] webpage videoId=${videoId} httpStatus=${response.status} bodyLength=${text.length} ` +
            `looksLikeChallenge=${text.includes('class="g-recaptcha"')} ` +
            `hasPlayability=${text.includes('"playabilityStatus":')} ` +
            `playabilityStatus=${statusMatch?.[1] ?? "?"} ` +
            `hasCaptionTracks=${text.includes('"captionTracks"')}`
        );
      }
    } catch (diagErr) {
      console.log(`[packageProvider] diagnostic logging failed for ${videoId}: ${String(diagErr)}`);
    }
    return response;
  };
}

/** A LOGIN_REQUIRED/CONTENT_CHECK_REQUIRED playabilityStatus from either
 *  underlying request overrides whatever the package itself concluded —
 *  see PLAYABILITY_BOT_BLOCK_STATUSES for why this is bot-block evidence,
 *  not "no captions". Classifying it correctly here (before the fallback
 *  matrix runs) avoids wastefully repeating the same blocked request via
 *  the InnerTube-raw fallback, which is terminalForAllProviders anyway. */
function reclassifyForPlayabilityStatus(capture: DiagnosticCapture, cause: unknown): TranscriptFetchError | null {
  if (capture.playabilityStatus && PLAYABILITY_BOT_BLOCK_STATUSES.has(capture.playabilityStatus)) {
    return new TranscriptFetchError(
      "YOUTUBE_BOT_BLOCKED",
      "YouTube returned a login-required playability status for an unauthenticated request.",
      { cause, safeContext: { playabilityStatus: capture.playabilityStatus } }
    );
  }
  return null;
}

function classifyPackageError(err: unknown): TranscriptFetchError {
  if (err instanceof YoutubeTranscriptTooManyRequestError) {
    return new TranscriptFetchError("YOUTUBE_BOT_BLOCKED", "YouTube served a rate-limit/CAPTCHA response.", {
      cause: err,
    });
  }
  if (err instanceof YoutubeTranscriptVideoUnavailableError) {
    return new TranscriptFetchError("VIDEO_UNAVAILABLE", "Video is unavailable.", { cause: err });
  }
  if (err instanceof YoutubeTranscriptNotAvailableLanguageError) {
    // Ambiguous on purpose: the package requires an *exact* languageCode
    // match, so this fires even when e.g. "en-US" exists but bare "en"
    // doesn't — the raw InnerTube fallback (with real track selection) may
    // still recover it.
    return new TranscriptFetchError("LANGUAGE_NOT_FOUND", "Exact requested language track not found.", {
      cause: err,
    });
  }
  if (err instanceof YoutubeTranscriptDisabledError) {
    // The package can't distinguish "genuinely no captions" from "YouTube
    // served a bot-limited response with no caption tracks" — both throw
    // this. Treated as ambiguous (fallback-eligible); only a second,
    // independent confirmation from the raw InnerTube provider elevates
    // this to a confirmed CAPTIONS_DISABLED.
    return new TranscriptFetchError("CAPTIONS_DISABLED", "No caption tracks found (unconfirmed).", { cause: err });
  }
  if (err instanceof YoutubeTranscriptNotAvailableError) {
    return new TranscriptFetchError("PARSER_ERROR", "Caption track fetch/parse failed unexpectedly.", { cause: err });
  }
  if (err instanceof Error && /network|fetch failed|ECONNRESET|ETIMEDOUT/i.test(err.message)) {
    return new TranscriptFetchError("NETWORK_ERROR", "Network error contacting YouTube.", { cause: err });
  }
  return new TranscriptFetchError("PARSER_ERROR", "Unexpected error from the transcript package.", { cause: err });
}

function toCaptionCues(items: PackageCue[]): CaptionCue[] {
  // Reuses the existing, already-proven ms-vs-seconds unit detection in
  // normalizeCues (src/lib/utils/segment.ts) instead of re-implementing it —
  // the package's raw offsets/durations carry the exact same ambiguity
  // (ms from InnerTube's srv3 XML, seconds from the classic webpage XML)
  // that function already handles.
  const normalized = normalizeCues(items.map((i) => ({ text: i.text, duration: i.duration, offset: i.offset })));
  return normalized.map((c) => ({
    text: c.text,
    startSeconds: c.startSec,
    durationSeconds: Math.max(0, c.endSec - c.startSec),
  }));
}

/**
 * Fetches an English transcript via the `youtube-transcript` package.
 * Throws a TranscriptFetchError on any failure — callers (orchestrator.ts)
 * decide whether that's fallback-eligible via `terminalForAllProviders`.
 */
export async function fetchViaPackage(videoId: string, language: string): Promise<TranscriptProviderResult> {
  const startedAt = Date.now();
  const capture: DiagnosticCapture = {};
  let items: PackageCue[] | undefined;
  try {
    items = await YoutubeTranscript.fetchTranscript(videoId, {
      lang: language,
      fetch: createDiagnosticFetch(videoId, capture),
    });
  } catch (err) {
    throw reclassifyForPlayabilityStatus(capture, err) ?? classifyPackageError(err);
  }

  if (!items || items.length === 0) {
    throw (
      reclassifyForPlayabilityStatus(capture, undefined) ??
      new TranscriptFetchError("INVALID_PROVIDER_RESPONSE", "Package returned no cues.", {
        safeContext: { cueCount: 0 },
      })
    );
  }

  return {
    provider: "youtube-transcript",
    languageCode: items[0]?.lang ?? language,
    cues: toCaptionCues(items),
    diagnostics: { attemptCount: 1, durationMs: Date.now() - startedAt },
  };
}
