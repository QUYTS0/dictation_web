import { withRetry, computeBackoffDelayMs, parseRetryAfterMs } from "@/lib/youtubeCaptions/retry";

class RetryableError extends Error {}
class PermanentError extends Error {}

describe("withRetry", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("retries a retryable failure with capped exponential backoff + jitter, then succeeds", async () => {
    let attempts = 0;
    const fn = jest.fn(async () => {
      attempts++;
      if (attempts < 3) throw new RetryableError("transient");
      return "ok";
    });

    const promise = withRetry(fn, {
      deadlineAt: Date.now() + 60_000,
      isRetryable: (err) => err instanceof RetryableError,
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: false,
    });

    // First attempt runs synchronously up to its await point.
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(200); // covers attempt1->2 (100ms) and attempt2->3 (200ms)
    await jest.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a permanent failure", async () => {
    const fn = jest.fn(async () => {
      throw new PermanentError("nope");
    });

    await expect(
      withRetry(fn, {
        deadlineAt: Date.now() + 60_000,
        isRetryable: (err) => err instanceof RetryableError,
        maxAttempts: 5,
      })
    ).rejects.toBeInstanceOf(PermanentError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops once the attempt cap is reached", async () => {
    const fn = jest.fn(async () => {
      throw new RetryableError("still failing");
    });

    const promise = withRetry(fn, {
      deadlineAt: Date.now() + 60_000,
      isRetryable: () => true,
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 20,
      jitter: false,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(RetryableError);
    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects a Retry-After hint over the computed backoff delay", async () => {
    let attempts = 0;
    const fn = jest.fn(async () => {
      attempts++;
      if (attempts < 2) throw new RetryableError("rate limited");
      return "ok";
    });

    const promise = withRetry(fn, {
      deadlineAt: Date.now() + 60_000,
      isRetryable: () => true,
      getRetryAfterMs: () => 5000,
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 200,
    });

    await jest.advanceTimersByTimeAsync(4999);
    expect(fn).toHaveBeenCalledTimes(1); // Retry-After (5000ms) not yet elapsed
    await jest.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(result).toBe("ok");
  });

  it("stops before crossing the deadline instead of sleeping past it", async () => {
    const fn = jest.fn(async () => {
      throw new RetryableError("still failing");
    });
    const deadlineAt = Date.now() + 50; // less than one backoff delay away

    await expect(
      withRetry(fn, {
        deadlineAt,
        isRetryable: () => true,
        maxAttempts: 10,
        baseDelayMs: 1000,
        maxDelayMs: 1000,
        jitter: false,
      })
    ).rejects.toBeInstanceOf(RetryableError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("computeBackoffDelayMs", () => {
  it("caps the delay at maxDelayMs", () => {
    const delay = computeBackoffDelayMs(10, { baseDelayMs: 300, maxDelayMs: 4000, jitter: false });
    expect(delay).toBe(4000);
  });

  it("doubles per attempt without jitter", () => {
    expect(computeBackoffDelayMs(1, { baseDelayMs: 100, maxDelayMs: 10_000, jitter: false })).toBe(100);
    expect(computeBackoffDelayMs(2, { baseDelayMs: 100, maxDelayMs: 10_000, jitter: false })).toBe(200);
    expect(computeBackoffDelayMs(3, { baseDelayMs: 100, maxDelayMs: 10_000, jitter: false })).toBe(400);
  });

  it("stays within [0, computedDelay] with jitter enabled", () => {
    for (let i = 0; i < 20; i++) {
      const delay = computeBackoffDelayMs(3, { baseDelayMs: 100, maxDelayMs: 10_000, jitter: true });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(400);
    }
  });
});

describe("parseRetryAfterMs", () => {
  it("parses a seconds value", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
  });

  it("returns undefined for missing/unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("not-a-value")).toBeUndefined();
  });

  it("parses an HTTP-date value into a non-negative ms delta", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
  });
});
