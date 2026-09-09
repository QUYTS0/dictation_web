// =====================================================
// Shared validation for anything that will become a persisted transcript —
// automatic (provider) results and manual/SRT/VTT/timestamp-paste imports
// alike. An HTTP 200 is not sufficient: YouTube can (and does) serve HTML
// challenge/consent pages, empty payloads, or corrupted timing with a
// success status. Nothing here mutates its input; every function returns a
// discriminated ValidationOutcome instead of throwing, so callers decide
// how to surface a rejection (typed error, log, etc).
// =====================================================

import type { CaptionCue, TranscriptProviderResult } from "./types";
import type { TranscriptFetchErrorCode } from "./errors";

export interface ValidationFailure {
  code: TranscriptFetchErrorCode;
  message: string;
  safeContext?: Record<string, string | number | boolean | undefined>;
}

export type ValidationOutcome = { ok: true } | { ok: false; failure: ValidationFailure };

const ok: ValidationOutcome = { ok: true };
function fail(code: TranscriptFetchErrorCode, message: string, safeContext?: ValidationFailure["safeContext"]): ValidationOutcome {
  return { ok: false, failure: { code, message, safeContext } };
}

/** How far a cue may start before the previous cue's end and still be
 *  treated as normal ASR overlap rather than corrupted/reversed timing. */
const OVERLAP_TOLERANCE_SEC = 2;
/** Above this duplicate-text ratio (with enough cues to be meaningful), the
 *  payload looks like a repeated error/placeholder fragment rather than
 *  real captions. */
const DUPLICATE_RATIO_THRESHOLD = 0.9;
const DUPLICATE_MIN_CUE_COUNT = 5;

const HTML_CHALLENGE_MARKERS = [
  "g-recaptcha",
  "consent.youtube.com",
  "accounts.google.com/servicelogin",
  "<html",
  "<!doctype html",
];

/**
 * Rejects an HTTP-200-but-not-really-captions response: a login/consent/
 * CAPTCHA challenge page, or anything that isn't a parseable timed-text
 * payload. Only status/content-type/length are ever logged by callers —
 * this function itself never logs the body.
 */
export function validateHttpPayload(response: {
  httpStatus: number;
  contentType: string | null;
  text: string;
}): ValidationOutcome {
  if (response.httpStatus < 200 || response.httpStatus >= 300) {
    return fail("NETWORK_ERROR", "Non-success HTTP status fetching captions.", {
      httpStatus: response.httpStatus,
    });
  }

  const sample = response.text.slice(0, 2000).toLowerCase();
  const looksLikeChallengePage = HTML_CHALLENGE_MARKERS.some((marker) => sample.includes(marker));
  if (looksLikeChallengePage) {
    return fail("YOUTUBE_BOT_BLOCKED", "Received an HTML challenge/consent page instead of captions.", {
      contentType: response.contentType ?? undefined,
      byteLength: response.text.length,
    });
  }

  if (response.text.trim().length === 0) {
    return fail("INVALID_PROVIDER_RESPONSE", "Empty response body.", {
      contentType: response.contentType ?? undefined,
    });
  }

  return ok;
}

function normalizedFullText(cues: CaptionCue[]): string {
  return cues
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** A cue whose text, once whitespace is stripped, has almost no letters is
 *  more likely markup debris or an error placeholder than real speech. */
function isMostlyNonAlpha(text: string): boolean {
  const stripped = text.replace(/\s+/g, "");
  if (stripped.length === 0) return true;
  const alphaCount = (stripped.match(/\p{L}/gu) ?? []).length;
  return alphaCount / stripped.length < 0.3;
}

export function validateCues(cues: CaptionCue[]): ValidationOutcome {
  if (cues.length === 0) {
    return fail("INVALID_PROVIDER_RESPONSE", "No cues found in provider response.");
  }

  const nonEmptyCues = cues.filter((c) => c.text.trim().length > 0);
  if (nonEmptyCues.length === 0) {
    return fail("INVALID_PROVIDER_RESPONSE", "Every cue had empty text.");
  }

  if (normalizedFullText(cues).length === 0) {
    return fail("INVALID_PROVIDER_RESPONSE", "Normalized transcript text is empty.");
  }

  let markupLikeCount = 0;
  for (const cue of nonEmptyCues) {
    if (!Number.isFinite(cue.startSeconds) || cue.startSeconds < 0) {
      return fail("INVALID_PROVIDER_RESPONSE", "Cue has a non-finite or negative start timestamp.", {
        startSeconds: cue.startSeconds,
      });
    }
    if (!Number.isFinite(cue.durationSeconds) || cue.durationSeconds < 0) {
      return fail("INVALID_PROVIDER_RESPONSE", "Cue has a non-finite or negative duration.", {
        durationSeconds: cue.durationSeconds,
      });
    }
    if (isMostlyNonAlpha(cue.text)) markupLikeCount++;
  }

  if (markupLikeCount / nonEmptyCues.length > 0.5) {
    return fail("INVALID_PROVIDER_RESPONSE", "Most cue text looks like markup or non-speech content.", {
      markupLikeRatio: Number((markupLikeCount / nonEmptyCues.length).toFixed(2)),
    });
  }

  // Ordering: small ASR overlap is normal; a cue starting well before the
  // previous cue *started* (not just ended) indicates corrupted/reversed
  // timing, not legitimate overlap.
  for (let i = 1; i < nonEmptyCues.length; i++) {
    const prev = nonEmptyCues[i - 1];
    const cur = nonEmptyCues[i];
    if (cur.startSeconds < prev.startSeconds - OVERLAP_TOLERANCE_SEC) {
      return fail("INVALID_PROVIDER_RESPONSE", "Severe cue timestamp reversal detected.", {
        previousStart: prev.startSeconds,
        nextStart: cur.startSeconds,
      });
    }
  }

  if (nonEmptyCues.length >= DUPLICATE_MIN_CUE_COUNT) {
    const seen = new Map<string, number>();
    for (const cue of nonEmptyCues) {
      const key = cue.text.trim().toLowerCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const distinctRatio = seen.size / nonEmptyCues.length;
    if (1 - distinctRatio > DUPLICATE_RATIO_THRESHOLD) {
      return fail("INVALID_PROVIDER_RESPONSE", "Cues are almost entirely duplicated text.", {
        distinctRatio: Number(distinctRatio.toFixed(2)),
      });
    }
  }

  return ok;
}

export function validateProviderResult(result: TranscriptProviderResult): ValidationOutcome {
  if (!result.languageCode.toLowerCase().startsWith("en")) {
    return fail("LANGUAGE_NOT_FOUND", "Selected track is not English.", {
      languageCode: result.languageCode,
    });
  }
  return validateCues(result.cues);
}

export interface MergedSegmentLike {
  segmentIndex: number;
  start: number;
  end: number;
  text: string;
}

/**
 * Sanity-checks mergeIntoSentences' output (src/lib/utils/segment.ts) before
 * persistence. This validates the existing function's output — it does not
 * change mergeIntoSentences itself.
 */
export function validateMergedSegments(segments: MergedSegmentLike[]): ValidationOutcome {
  if (segments.length === 0) {
    return fail("INVALID_PROVIDER_RESPONSE", "Sentence merge produced zero segments.");
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.segmentIndex !== i) {
      return fail("INVALID_PROVIDER_RESPONSE", "Segment indexes are not sequential.", { at: i });
    }
    if (!Number.isFinite(seg.start) || !Number.isFinite(seg.end) || seg.end <= seg.start) {
      return fail("INVALID_PROVIDER_RESPONSE", "Segment has an invalid time range.", {
        at: i,
        start: seg.start,
        end: seg.end,
      });
    }
    if (!seg.text.trim()) {
      return fail("INVALID_PROVIDER_RESPONSE", "Segment has empty text.", { at: i });
    }
    if (i > 0 && seg.start < segments[i - 1].start) {
      return fail("INVALID_PROVIDER_RESPONSE", "Segments are not in chronological order.", { at: i });
    }
  }
  return ok;
}

/**
 * Same shape of checks as validateMergedSegments, reused for manual paste /
 * SRT / VTT / timestamp-paste imports before they're POSTed (client) and
 * again server-side (generate/route.ts) as defense in depth — a client
 * can't be trusted to have actually run its own validation.
 */
export function validateManualSegments(segments: MergedSegmentLike[]): ValidationOutcome {
  return validateMergedSegments(segments);
}
