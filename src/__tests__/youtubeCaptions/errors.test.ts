import {
  TranscriptFetchError,
  toTranscriptFetchError,
  httpStatusForCode,
  getTranscriptErrorMessage,
  isRetryableCode,
  isTerminalForAllProviders,
} from "@/lib/youtubeCaptions/errors";

describe("TranscriptFetchError", () => {
  it("never leaks the raw cause via toSafeMessage()", () => {
    const err = new TranscriptFetchError("NETWORK_ERROR", "internal detail with a stack trace", {
      cause: new Error("some raw upstream response body"),
    });
    expect(err.toSafeMessage()).not.toContain("raw upstream response body");
  });

  it("marks NETWORK_ERROR/TIMEOUT retryable and everything else not", () => {
    expect(isRetryableCode("NETWORK_ERROR")).toBe(true);
    expect(isRetryableCode("TIMEOUT")).toBe(true);
    expect(isRetryableCode("CAPTIONS_DISABLED")).toBe(false);
    expect(isRetryableCode("YOUTUBE_BOT_BLOCKED")).toBe(false);
  });

  it("marks bot-block/rate-limit/access-restriction codes terminal for all providers", () => {
    for (const code of ["YOUTUBE_RATE_LIMITED", "YOUTUBE_BOT_BLOCKED", "VIDEO_PRIVATE", "AGE_RESTRICTED", "REGION_RESTRICTED"] as const) {
      expect(isTerminalForAllProviders(code)).toBe(true);
    }
    expect(isTerminalForAllProviders("PARSER_ERROR")).toBe(false);
    expect(isTerminalForAllProviders("LANGUAGE_NOT_FOUND")).toBe(false);
  });

  it("wraps an unknown thrown value", () => {
    const wrapped = toTranscriptFetchError(new Error("boom"));
    expect(wrapped).toBeInstanceOf(TranscriptFetchError);
    expect(wrapped.code).toBe("UNKNOWN_TRANSCRIPT_ERROR");
  });

  it("passes an existing TranscriptFetchError through unchanged", () => {
    const original = new TranscriptFetchError("PARSER_ERROR", "bad");
    expect(toTranscriptFetchError(original)).toBe(original);
  });
});

describe("httpStatusForCode", () => {
  it("maps rate-limit/bot-block/network codes to 503", () => {
    for (const code of ["YOUTUBE_RATE_LIMITED", "YOUTUBE_BOT_BLOCKED", "NETWORK_ERROR", "TIMEOUT", "FETCH_COOLDOWN"] as const) {
      expect(httpStatusForCode(code)).toBe(503);
    }
  });
  it("maps caption-availability codes to 422", () => {
    for (const code of ["CAPTIONS_DISABLED", "LANGUAGE_NOT_FOUND", "VIDEO_UNAVAILABLE"] as const) {
      expect(httpStatusForCode(code)).toBe(422);
    }
  });
  it("maps GENERATION_IN_PROGRESS to 202", () => {
    expect(httpStatusForCode("GENERATION_IN_PROGRESS")).toBe(202);
  });
});

describe("getTranscriptErrorMessage", () => {
  it("never claims captions are disabled for an ambiguous/bot-block code", () => {
    expect(getTranscriptErrorMessage("YOUTUBE_BOT_BLOCKED")).not.toMatch(/disabled/i);
    expect(getTranscriptErrorMessage("PARSER_ERROR")).not.toMatch(/disabled/i);
  });
  it("falls back to a generic message for a null/unknown code", () => {
    expect(getTranscriptErrorMessage(null)).toBeTruthy();
    expect(getTranscriptErrorMessage("SOME_UNKNOWN_CODE")).toBeTruthy();
  });
  it("handles the lock/cooldown pseudo-codes too", () => {
    expect(getTranscriptErrorMessage("GENERATION_IN_PROGRESS")).toBeTruthy();
    expect(getTranscriptErrorMessage("FETCH_COOLDOWN")).toBeTruthy();
  });
});
