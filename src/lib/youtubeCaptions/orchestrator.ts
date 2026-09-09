// =====================================================
// Sequences the two English caption providers with the fallback matrix
// documented below, validates whichever result comes back, and applies
// per-attempt retry (retry.ts) within the caller-supplied deadline.
//
// Deliberately does NOT own locking, cooldown, or metrics — those are
// route-level concerns (see generate/route.ts) wired *around* a call to
// generateEnglishTranscript, so this module stays a narrowly-testable pure
// function: same videoId + mocked providers in, same result out.
//
// Fallback matrix:
//   1. youtube-transcript (package)
//      -> falls through to innertube-raw on: parser/shape errors, missing
//         playerCaptionsTracklistRenderer, ambiguous-empty results,
//         "exact language not found" (an alternate English track like
//         en-US may still exist), or a payload that fails validation.
//      -> does NOT fall through (goes straight to a typed error) on: 429,
//         bot/CAPTCHA block, video unavailable/private/age/region-restricted
//         — see TranscriptFetchError.terminalForAllProviders.
//   2. innertube-raw (only reached per the rule above; never run in
//      parallel with step 1 — that would double YouTube traffic).
//   3. A typed TranscriptFetchError — the caller (route.ts) decides how to
//      surface it (cooldown, response body, etc).
// =====================================================

import type { CueItem } from "@/lib/utils/segment";
import { fetchViaPackage } from "./packageProvider";
import { fetchViaInnerTube } from "./innerTubeProvider";
import { validateProviderResult } from "./validation";
import { TranscriptFetchError, toTranscriptFetchError } from "./errors";
import { withRetry } from "./retry";
import type { CaptionCue, TranscriptProviderResult } from "./types";

export interface GenerateEnglishTranscriptOptions {
  /** Absolute Date.now()-style deadline covering this whole call. */
  deadlineAt: number;
  language?: string;
}

interface BaseOutcome {
  attemptCount: number;
  fallbackUsed: boolean;
}

export type GenerateEnglishTranscriptOutcome =
  | (BaseOutcome & { ok: true; result: TranscriptProviderResult })
  | (BaseOutcome & { ok: false; error: TranscriptFetchError });

/** Converts the subsystem's seconds-based CaptionCue into the ms-based
 *  CueItem shape src/lib/utils/segment.ts's (unmodified) mergeIntoSentences
 *  already expects — the only touch point with that existing pipeline. */
export function toCueItems(cues: CaptionCue[]): CueItem[] {
  return cues.map((c) => ({
    text: c.text,
    offset: c.startSeconds * 1000,
    duration: c.durationSeconds * 1000,
  }));
}

async function attemptProvider(
  fetchFn: () => Promise<TranscriptProviderResult>,
  deadlineAt: number,
  onAttempt: () => void
): Promise<TranscriptProviderResult> {
  return withRetry(
    async () => {
      onAttempt();
      const result = await fetchFn();
      const validation = validateProviderResult(result);
      if (!validation.ok) {
        throw new TranscriptFetchError(validation.failure.code, validation.failure.message, {
          safeContext: validation.failure.safeContext,
        });
      }
      return result;
    },
    {
      deadlineAt,
      isRetryable: (err) => err instanceof TranscriptFetchError && err.retryable,
      getRetryAfterMs: (err) => (err instanceof TranscriptFetchError ? err.retryAfterMs : undefined),
    }
  );
}

export async function generateEnglishTranscript(
  videoId: string,
  options: GenerateEnglishTranscriptOptions
): Promise<GenerateEnglishTranscriptOutcome> {
  const language = options.language ?? "en";
  let attemptCount = 0;
  const countAttempt = () => {
    attemptCount++;
  };

  let packageError: TranscriptFetchError;
  try {
    const result = await attemptProvider(() => fetchViaPackage(videoId, language), options.deadlineAt, countAttempt);
    return { ok: true, result, attemptCount, fallbackUsed: false };
  } catch (err) {
    packageError = toTranscriptFetchError(err);
  }

  if (packageError.terminalForAllProviders) {
    return { ok: false, error: packageError, attemptCount, fallbackUsed: false };
  }
  if (Date.now() >= options.deadlineAt) {
    return {
      ok: false,
      error: new TranscriptFetchError(
        "REQUEST_DEADLINE_EXCEEDED",
        "Deadline reached before the InnerTube fallback could run.",
        { cause: packageError }
      ),
      attemptCount,
      fallbackUsed: false,
    };
  }

  try {
    const result = await attemptProvider(() => fetchViaInnerTube(videoId), options.deadlineAt, countAttempt);
    return { ok: true, result, attemptCount, fallbackUsed: true };
  } catch (err) {
    return { ok: false, error: toTranscriptFetchError(err), attemptCount, fallbackUsed: true };
  }
}
