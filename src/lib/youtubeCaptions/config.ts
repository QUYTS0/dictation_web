// =====================================================
// Centralized configuration for transcript-fetch reliability.
// Every magic number used by retry/backoff, the distributed lock, and
// cooldown/negative-caching lives here so behavior can be reasoned about
// (and tuned) from one place instead of scattered across providers/routes.
// =====================================================

/** Total wall-clock budget for one /api/transcript/generate request, covering
 *  lock acquisition through Supabase writes. Kept comfortably under the
 *  route's `maxDuration = 60` (see generate/route.ts) so a controlled
 *  response is always returned instead of a platform-level timeout. */
export const ROUTE_DEADLINE_MS = 45_000;

/** Per-attempt network timeout for a single provider HTTP call. */
export const PROVIDER_FETCH_TIMEOUT_MS = 10_000;

export const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 4_000,
  /** Full jitter: actual delay is a uniform random value in [0, computedDelay]. */
  jitter: true,
} as const;

/** Distributed single-flight generation lock. */
export const LOCK_CONFIG = {
  /** Long enough to cover a full provider attempt + backoff + Supabase writes;
   *  short enough that a crashed function instance doesn't wedge the video
   *  for long. */
  ttlMs: 30_000,
  /** Hint returned to a contended caller for when to poll again. */
  contendedRetryAfterMs: 4_000,
} as const;

/** Negative-caching ("cooldown") durations, keyed by failure category. A
 *  category being *not* listed here means "don't set a cooldown for it"
 *  (e.g. a single-provider parser error that's about to be retried by the
 *  other provider shouldn't suppress that other provider). */
export const COOLDOWN_MS = {
  /** YouTube itself is rate-limiting/blocking this server — back off hard. */
  YOUTUBE_RATE_LIMITED: 15 * 60_000,
  YOUTUBE_BOT_BLOCKED: 15 * 60_000,
  /** A stable fact about the video (no English captions at all) — safe to
   *  remember for a long time, but Force Retry can still bypass it. */
  CAPTIONS_DISABLED: 12 * 60 * 60_000,
  LANGUAGE_NOT_FOUND: 12 * 60 * 60_000,
  VIDEO_UNAVAILABLE: 12 * 60 * 60_000,
  VIDEO_PRIVATE: 12 * 60 * 60_000,
  AGE_RESTRICTED: 12 * 60 * 60_000,
  REGION_RESTRICTED: 12 * 60 * 60_000,
  /** Both providers failed for an unclear/transient reason — short cooldown
   *  so an immediate client retry-storm doesn't just repeat the same call. */
  NETWORK_ERROR: 45_000,
  TIMEOUT: 45_000,
  UNKNOWN_TRANSCRIPT_ERROR: 45_000,
} as const;

export type CooldownEligibleCode = keyof typeof COOLDOWN_MS;

export function isCooldownEligible(code: string): code is CooldownEligibleCode {
  return Object.prototype.hasOwnProperty.call(COOLDOWN_MS, code);
}
