// =====================================================
// Typed transcript-fetch errors.
//
// A closed error-code union lets generate/route.ts (and eventually the
// client) branch on *why* a fetch failed instead of pattern-matching on
// message strings scattered across two provider implementations. The
// original cause (raw Error, HTTP status, response snippet) is kept on the
// instance for server-side logs only — `toSafeMessage()` is the one thing
// that's safe to put in a client-facing response body.
// =====================================================

export type TranscriptFetchErrorCode =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "YOUTUBE_RATE_LIMITED"
  | "YOUTUBE_BOT_BLOCKED"
  | "CAPTIONS_DISABLED"
  | "CAPTION_TRACK_NOT_FOUND"
  | "LANGUAGE_NOT_FOUND"
  | "VIDEO_UNAVAILABLE"
  | "VIDEO_PRIVATE"
  | "AGE_RESTRICTED"
  | "REGION_RESTRICTED"
  | "PARSER_ERROR"
  | "INVALID_PROVIDER_RESPONSE"
  | "GENERATION_IN_PROGRESS"
  | "FETCH_COOLDOWN"
  | "REQUEST_DEADLINE_EXCEEDED"
  | "UNKNOWN_TRANSCRIPT_ERROR";

/**
 * Whether a code represents a stable fact about the video/request (never
 * worth retrying automatically within the same request) vs. something that
 * might recover on its own. Used by retry.ts and orchestrator.ts — kept
 * here, next to the codes themselves, so the two can't drift apart.
 */
const RETRYABLE_CODES = new Set<TranscriptFetchErrorCode>([
  "NETWORK_ERROR",
  "TIMEOUT",
]);

export function isRetryableCode(code: TranscriptFetchErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/**
 * Codes that represent a durable, provider-independent fact ("this video has
 * no English captions") vs. a transient/provider-specific hiccup that the
 * *other* provider might still recover from. Used by the orchestrator's
 * fallback matrix.
 */
const TERMINAL_FOR_ALL_PROVIDERS = new Set<TranscriptFetchErrorCode>([
  "YOUTUBE_RATE_LIMITED",
  "YOUTUBE_BOT_BLOCKED",
  "VIDEO_UNAVAILABLE",
  "VIDEO_PRIVATE",
  "AGE_RESTRICTED",
  "REGION_RESTRICTED",
]);

export function isTerminalForAllProviders(code: TranscriptFetchErrorCode): boolean {
  return TERMINAL_FOR_ALL_PROVIDERS.has(code);
}

export interface TranscriptFetchErrorOptions {
  /** Original thrown value — logged server-side only, never sent to the client. */
  cause?: unknown;
  /** Safe (non-sensitive) extra context for structured logs, e.g. { httpStatus: 429 }. */
  safeContext?: Record<string, string | number | boolean | undefined>;
  retryAfterMs?: number;
}

export class TranscriptFetchError extends Error {
  readonly code: TranscriptFetchErrorCode;
  readonly cause?: unknown;
  readonly safeContext?: Record<string, string | number | boolean | undefined>;
  readonly retryAfterMs?: number;

  constructor(code: TranscriptFetchErrorCode, message: string, options: TranscriptFetchErrorOptions = {}) {
    super(message);
    this.name = "TranscriptFetchError";
    this.code = code;
    this.cause = options.cause;
    this.safeContext = options.safeContext;
    this.retryAfterMs = options.retryAfterMs;
  }

  get retryable(): boolean {
    return isRetryableCode(this.code);
  }

  get terminalForAllProviders(): boolean {
    return isTerminalForAllProviders(this.code);
  }

  /** User-facing message — deliberately generic for anything that could hint at bot-detection internals. */
  toSafeMessage(): string {
    return USER_MESSAGES[this.code] ?? USER_MESSAGES.UNKNOWN_TRANSCRIPT_ERROR;
  }
}

const USER_MESSAGES: Record<TranscriptFetchErrorCode, string> = {
  NETWORK_ERROR: "A temporary network error occurred while fetching captions. Please try again.",
  TIMEOUT: "Fetching captions took too long. Please try again.",
  YOUTUBE_RATE_LIMITED:
    "YouTube is temporarily blocking automated caption requests from our server. Please try again in a few minutes.",
  YOUTUBE_BOT_BLOCKED:
    "YouTube is temporarily blocking automated caption requests from our server. Please try again in a few minutes.",
  CAPTIONS_DISABLED: "Captions are disabled for this video. Please choose a video with captions enabled, or paste/upload a transcript.",
  CAPTION_TRACK_NOT_FOUND: "No caption track could be found for this video.",
  LANGUAGE_NOT_FOUND: "No English captions available for this video. Try a different video, or paste/upload a transcript.",
  VIDEO_UNAVAILABLE: "This video is unavailable (private, deleted, or restricted in some regions).",
  VIDEO_PRIVATE: "This video is private and its captions can't be accessed.",
  AGE_RESTRICTED: "This video is age-restricted and its captions can't be accessed automatically.",
  REGION_RESTRICTED: "This video is restricted in the server's region and its captions can't be accessed.",
  PARSER_ERROR: "Captions could not be read from YouTube's response. Please try again.",
  INVALID_PROVIDER_RESPONSE: "YouTube returned an unexpected response instead of captions. Please try again.",
  GENERATION_IN_PROGRESS: "A transcript is already being generated for this video. Please wait a moment.",
  FETCH_COOLDOWN: "Automatic transcript access is temporarily unavailable for this video. Please try again shortly.",
  REQUEST_DEADLINE_EXCEEDED: "Fetching captions took too long. Please try again.",
  UNKNOWN_TRANSCRIPT_ERROR: "Captions could not be fetched automatically for this video.",
};

const HTTP_STATUS_BY_CODE: Record<TranscriptFetchErrorCode, number> = {
  NETWORK_ERROR: 503,
  TIMEOUT: 503,
  YOUTUBE_RATE_LIMITED: 503,
  YOUTUBE_BOT_BLOCKED: 503,
  CAPTIONS_DISABLED: 422,
  CAPTION_TRACK_NOT_FOUND: 422,
  LANGUAGE_NOT_FOUND: 422,
  VIDEO_UNAVAILABLE: 422,
  VIDEO_PRIVATE: 422,
  AGE_RESTRICTED: 422,
  REGION_RESTRICTED: 422,
  PARSER_ERROR: 422,
  INVALID_PROVIDER_RESPONSE: 422,
  GENERATION_IN_PROGRESS: 202,
  FETCH_COOLDOWN: 503,
  REQUEST_DEADLINE_EXCEEDED: 503,
  UNKNOWN_TRANSCRIPT_ERROR: 422,
};

/** HTTP status to report to the client for a given error code — centralized
 *  so generate/route.ts doesn't re-derive it ad hoc per branch. */
export function httpStatusForCode(code: TranscriptFetchErrorCode): number {
  return HTTP_STATUS_BY_CODE[code] ?? 422;
}

/**
 * Client-safe lookup by bare code string (as opposed to `TranscriptFetchError#toSafeMessage()`,
 * which needs an actual error instance) — used by the transcript_failed UI
 * card (page.tsx) so its copy stays in sync with the server's own
 * classification instead of drifting into a second hand-written mapping.
 * Also accepts "GENERATION_IN_PROGRESS"/"FETCH_COOLDOWN", which aren't part
 * of the per-provider error taxonomy but travel through the same `code`
 * field in generate/route.ts's response.
 */
const EXTRA_CLIENT_MESSAGES: Record<string, string> = {
  GENERATION_IN_PROGRESS: USER_MESSAGES.GENERATION_IN_PROGRESS,
  FETCH_COOLDOWN: USER_MESSAGES.FETCH_COOLDOWN,
};

export function getTranscriptErrorMessage(code: string | null | undefined): string {
  if (!code) return USER_MESSAGES.UNKNOWN_TRANSCRIPT_ERROR;
  return USER_MESSAGES[code as TranscriptFetchErrorCode] ?? EXTRA_CLIENT_MESSAGES[code] ?? USER_MESSAGES.UNKNOWN_TRANSCRIPT_ERROR;
}

/** Convenience for wrapping an unknown thrown value that isn't already typed. */
export function toTranscriptFetchError(err: unknown, fallbackCode: TranscriptFetchErrorCode = "UNKNOWN_TRANSCRIPT_ERROR"): TranscriptFetchError {
  if (err instanceof TranscriptFetchError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new TranscriptFetchError(fallbackCode, message, { cause: err });
}
