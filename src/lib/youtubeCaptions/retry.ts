// =====================================================
// Generic capped-exponential-backoff-with-jitter retry helper, bounded by a
// caller-supplied wall-clock deadline. Deliberately error-agnostic (callers
// supply `isRetryable`/`getRetryAfterMs`) so it can wrap either provider's
// HTTP calls without knowing about TranscriptFetchError itself.
// =====================================================

import { RETRY_CONFIG } from "./config";

export interface RetryOptions<E = unknown> {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Full jitter (uniform random in [0, computedDelay]) when true (default). */
  jitter?: boolean;
  /** Absolute Date.now()-style deadline. No further attempt is started once
   *  the next delay would land at or past this. */
  deadlineAt: number;
  isRetryable: (err: E) => boolean;
  /** Extracts a `Retry-After`-style hint (ms) from a caught error, if any —
   *  takes precedence over the computed backoff delay when present. */
  getRetryAfterMs?: (err: E) => number | undefined;
  /** Injectable for tests; defaults to a real setTimeout-based sleep, which
   *  works fine under jest.useFakeTimers()/advanceTimersByTimeAsync. */
  sleep?: (ms: number) => Promise<void>;
}

export function computeBackoffDelayMs(
  attempt: number,
  opts: { baseDelayMs: number; maxDelayMs: number; jitter: boolean }
): number {
  const raw = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
  if (!opts.jitter) return raw;
  return Math.floor(Math.random() * raw);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying on failures `isRetryable` accepts, up to `maxAttempts`
 * total attempts, with capped exponential backoff + jitter between them.
 * Stops (rethrows the last error) as soon as a permanent failure is seen,
 * the attempt cap is hit, or the next delay would cross `deadlineAt` — it
 * never sleeps past the deadline just to make one more doomed attempt.
 */
export async function withRetry<T, E = unknown>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions<E>
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? RETRY_CONFIG.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? RETRY_CONFIG.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? RETRY_CONFIG.maxDelayMs;
  const jitter = options.jitter ?? RETRY_CONFIG.jitter;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = options.isRetryable(err as E);
      if (!retryable || attempt >= maxAttempts) throw err;

      const retryAfterMs = options.getRetryAfterMs?.(err as E);
      const delayMs = retryAfterMs ?? computeBackoffDelayMs(attempt, { baseDelayMs, maxDelayMs, jitter });

      if (Date.now() + delayMs >= options.deadlineAt) throw err;
      await sleep(delayMs);
    }
  }
  // Unreachable (loop always returns or throws), but keeps TypeScript happy.
  throw new Error("withRetry: exhausted attempts without a result");
}

/** Parses an HTTP `Retry-After` header value (seconds, or an HTTP-date) into
 *  milliseconds from now. Returns undefined for anything unparseable. */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const deltaMs = dateMs - Date.now();
    return deltaMs > 0 ? deltaMs : 0;
  }
  return undefined;
}
