import { TranscriptFetchError } from "@/lib/youtubeCaptions/errors";
import type { TranscriptProviderResult } from "@/lib/youtubeCaptions/types";

const fetchViaPackage = jest.fn();
const fetchViaInnerTube = jest.fn();

jest.mock("@/lib/youtubeCaptions/packageProvider", () => ({
  fetchViaPackage: (...args: unknown[]) => fetchViaPackage(...args),
}));
jest.mock("@/lib/youtubeCaptions/innerTubeProvider", () => ({
  fetchViaInnerTube: (...args: unknown[]) => fetchViaInnerTube(...args),
}));

import { generateEnglishTranscript, toCueItems } from "@/lib/youtubeCaptions/orchestrator";

function goodResult(provider: "youtube-transcript" | "innertube-raw"): TranscriptProviderResult {
  return {
    provider,
    languageCode: "en",
    cues: [
      { text: "Hello and welcome.", startSeconds: 0, durationSeconds: 2 },
      { text: "This is a test video.", startSeconds: 2, durationSeconds: 2 },
    ],
    diagnostics: { attemptCount: 1, durationMs: 5 },
  };
}

describe("generateEnglishTranscript orchestration", () => {
  beforeEach(() => {
    fetchViaPackage.mockReset();
    fetchViaInnerTube.mockReset();
  });

  it("succeeds via the package provider without calling innerTube", async () => {
    fetchViaPackage.mockResolvedValue(goodResult("youtube-transcript"));
    const outcome = await generateEnglishTranscript("vid1", { deadlineAt: Date.now() + 30_000 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.provider).toBe("youtube-transcript");
    expect(outcome.fallbackUsed).toBe(false);
    expect(fetchViaInnerTube).not.toHaveBeenCalled();
  });

  it("falls back to innerTube on a package parser failure", async () => {
    fetchViaPackage.mockRejectedValue(new TranscriptFetchError("PARSER_ERROR", "bad shape"));
    fetchViaInnerTube.mockResolvedValue(goodResult("innertube-raw"));
    const outcome = await generateEnglishTranscript("vid2", { deadlineAt: Date.now() + 30_000 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.provider).toBe("innertube-raw");
    expect(outcome.fallbackUsed).toBe(true);
  });

  it("falls back to innerTube on an ambiguous 'language not found' (exact 'en' missing)", async () => {
    fetchViaPackage.mockRejectedValue(new TranscriptFetchError("LANGUAGE_NOT_FOUND", "exact en missing"));
    fetchViaInnerTube.mockResolvedValue(goodResult("innertube-raw"));
    const outcome = await generateEnglishTranscript("vid3", { deadlineAt: Date.now() + 30_000 });
    expect(outcome.ok).toBe(true);
    expect(fetchViaInnerTube).toHaveBeenCalledTimes(1);
  });

  it("does not call innerTube after a confirmed bot-block/429 — goes straight to a typed error", async () => {
    fetchViaPackage.mockRejectedValue(new TranscriptFetchError("YOUTUBE_BOT_BLOCKED", "captcha required"));
    const outcome = await generateEnglishTranscript("vid4", { deadlineAt: Date.now() + 30_000 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("YOUTUBE_BOT_BLOCKED");
    expect(fetchViaInnerTube).not.toHaveBeenCalled();
  });

  it("returns a typed error when both providers fail", async () => {
    fetchViaPackage.mockRejectedValue(new TranscriptFetchError("PARSER_ERROR", "bad shape"));
    fetchViaInnerTube.mockRejectedValue(new TranscriptFetchError("CAPTIONS_DISABLED", "confirmed"));
    const outcome = await generateEnglishTranscript("vid5", { deadlineAt: Date.now() + 30_000 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("CAPTIONS_DISABLED");
    expect(outcome.fallbackUsed).toBe(true);
  });

  it("never calls both providers concurrently — innerTube only starts after package settles", async () => {
    const callOrder: string[] = [];
    fetchViaPackage.mockImplementation(async () => {
      callOrder.push("package-start");
      throw new TranscriptFetchError("PARSER_ERROR", "bad shape");
    });
    fetchViaInnerTube.mockImplementation(async () => {
      callOrder.push("innertube-start");
      return goodResult("innertube-raw");
    });
    await generateEnglishTranscript("vid6", { deadlineAt: Date.now() + 30_000 });
    expect(callOrder).toEqual(["package-start", "innertube-start"]);
  });

  it("rejects an invalid provider result via validation instead of returning it", async () => {
    fetchViaPackage.mockResolvedValue({
      provider: "youtube-transcript",
      languageCode: "en",
      cues: [],
      diagnostics: { attemptCount: 1, durationMs: 1 },
    });
    fetchViaInnerTube.mockResolvedValue({
      provider: "innertube-raw",
      languageCode: "en",
      cues: [],
      diagnostics: { attemptCount: 1, durationMs: 1 },
    });
    const outcome = await generateEnglishTranscript("vid7", { deadlineAt: Date.now() + 30_000 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("INVALID_PROVIDER_RESPONSE");
  });
});

describe("toCueItems", () => {
  it("converts seconds-based CaptionCue into ms-based CueItem", () => {
    const items = toCueItems([{ text: "Hi", startSeconds: 1.5, durationSeconds: 2 }]);
    expect(items).toEqual([{ text: "Hi", offset: 1500, duration: 2000 }]);
  });
});
