import {
  validateHttpPayload,
  validateCues,
  validateProviderResult,
  validateMergedSegments,
} from "@/lib/youtubeCaptions/validation";
import type { CaptionCue, TranscriptProviderResult } from "@/lib/youtubeCaptions/types";

function cue(text: string, startSeconds: number, durationSeconds = 2): CaptionCue {
  return { text, startSeconds, durationSeconds };
}

describe("validateHttpPayload", () => {
  it("rejects a non-2xx status", () => {
    const outcome = validateHttpPayload({ httpStatus: 500, contentType: "text/xml", text: "oops" });
    expect(outcome.ok).toBe(false);
  });

  it("rejects an HTML consent/CAPTCHA challenge page even with HTTP 200", () => {
    const outcome = validateHttpPayload({
      httpStatus: 200,
      contentType: "text/html",
      text: '<html><body><div class="g-recaptcha"></div></body></html>',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.code).toBe("YOUTUBE_BOT_BLOCKED");
  });

  it("accepts a normal XML payload", () => {
    const outcome = validateHttpPayload({
      httpStatus: 200,
      contentType: "text/xml",
      text: '<transcript><text start="0" dur="2">Hello</text></transcript>',
    });
    expect(outcome.ok).toBe(true);
  });

  it("rejects an empty body", () => {
    const outcome = validateHttpPayload({ httpStatus: 200, contentType: "text/xml", text: "   " });
    expect(outcome.ok).toBe(false);
  });
});

describe("validateCues", () => {
  it("rejects an empty cue list", () => {
    expect(validateCues([]).ok).toBe(false);
  });

  it("rejects cues whose normalized text is empty", () => {
    expect(validateCues([cue("   ", 0), cue("", 1)]).ok).toBe(false);
  });

  it("rejects a non-finite/negative timestamp", () => {
    expect(validateCues([cue("hello", -1)]).ok).toBe(false);
    expect(validateCues([{ text: "hello", startSeconds: NaN, durationSeconds: 1 }]).ok).toBe(false);
  });

  it("accepts normal ASR-style small overlaps", () => {
    const cues = [cue("Hello there", 0, 2.5), cue("how are you", 2.0, 2)]; // 0.5s overlap
    expect(validateCues(cues).ok).toBe(true);
  });

  it("rejects severe timestamp reversal", () => {
    const cues = [cue("Hello there, this is a normal sentence", 50), cue("and here is another one", 0)];
    const outcome = validateCues(cues);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.code).toBe("INVALID_PROVIDER_RESPONSE");
  });

  it("rejects cue text that's mostly markup/non-alpha", () => {
    const cues = Array.from({ length: 6 }, (_, i) => cue("### --- ***", i * 2));
    expect(validateCues(cues).ok).toBe(false);
  });

  it("rejects an overwhelmingly duplicated cue list", () => {
    const cues = Array.from({ length: 20 }, (_, i) => cue("same text every time", i * 2));
    const outcome = validateCues(cues);
    expect(outcome.ok).toBe(false);
  });

  it("accepts normal varied captions", () => {
    const cues = [
      cue("Hello and welcome to the video.", 0, 2),
      cue("Today we're going to talk about testing.", 2, 3),
      cue("Let's get started right away.", 5, 2),
    ];
    expect(validateCues(cues).ok).toBe(true);
  });
});

describe("validateProviderResult", () => {
  it("rejects a non-English languageCode even with valid cues", () => {
    const result: TranscriptProviderResult = {
      provider: "innertube-raw",
      languageCode: "fr",
      cues: [cue("Bonjour tout le monde", 0)],
      diagnostics: { attemptCount: 1, durationMs: 10 },
    };
    const outcome = validateProviderResult(result);
    expect(outcome.ok).toBe(false);
  });

  it("accepts a valid English result", () => {
    const result: TranscriptProviderResult = {
      provider: "innertube-raw",
      languageCode: "en-US",
      cues: [cue("Hello and welcome.", 0), cue("This is a test.", 2)],
      diagnostics: { attemptCount: 1, durationMs: 10 },
    };
    expect(validateProviderResult(result).ok).toBe(true);
  });
});

describe("validateMergedSegments", () => {
  it("rejects zero segments", () => {
    expect(validateMergedSegments([]).ok).toBe(false);
  });

  it("rejects non-sequential segment indexes", () => {
    const segs = [
      { segmentIndex: 0, start: 0, end: 2, text: "Hi." },
      { segmentIndex: 2, start: 2, end: 4, text: "Bye." },
    ];
    expect(validateMergedSegments(segs).ok).toBe(false);
  });

  it("rejects a segment with end <= start", () => {
    const segs = [{ segmentIndex: 0, start: 2, end: 2, text: "Hi." }];
    expect(validateMergedSegments(segs).ok).toBe(false);
  });

  it("rejects out-of-order segments", () => {
    const segs = [
      { segmentIndex: 0, start: 5, end: 7, text: "Second in time." },
      { segmentIndex: 1, start: 0, end: 2, text: "First in time." },
    ];
    expect(validateMergedSegments(segs).ok).toBe(false);
  });

  it("accepts well-formed sequential segments", () => {
    const segs = [
      { segmentIndex: 0, start: 0, end: 2, text: "Hi there." },
      { segmentIndex: 1, start: 2, end: 4, text: "How are you?" },
    ];
    expect(validateMergedSegments(segs).ok).toBe(true);
  });
});
