import {
  currentSentenceProblemWords,
  deriveEvaluationUiState,
  feedbackFor,
  scoreTierFor,
  semanticTierFor,
  tierLabel,
  weakestMetric,
} from "@/app/dictation/[videoId]/evaluationFeedback";
import type { TrueEvaluationResult, TrueEvaluationWord } from "@/app/dictation/[videoId]/types";

describe("scoreTierFor", () => {
  it("boundary at 90/89", () => {
    expect(scoreTierFor(90)).toBe("excellent");
    expect(scoreTierFor(89)).toBe("great");
  });
  it("boundary at 75/74", () => {
    expect(scoreTierFor(75)).toBe("great");
    expect(scoreTierFor(74)).toBe("good");
  });
  it("boundary at 60/59", () => {
    expect(scoreTierFor(60)).toBe("good");
    expect(scoreTierFor(59)).toBe("keep-practicing");
  });
  it("labels every tier", () => {
    expect(tierLabel("excellent")).toBe("Excellent");
    expect(tierLabel("great")).toBe("Great");
    expect(tierLabel("good")).toBe("Good");
    expect(tierLabel("keep-practicing")).toBe("Keep practicing");
  });
});

describe("semanticTierFor", () => {
  it("boundary at 80/79", () => {
    expect(semanticTierFor(80)).toBe("strong");
    expect(semanticTierFor(79)).toBe("moderate");
  });
  it("boundary at 60/59", () => {
    expect(semanticTierFor(60)).toBe("moderate");
    expect(semanticTierFor(59)).toBe("weak");
  });
  it("treats 0 as a valid, weak value rather than throwing", () => {
    expect(semanticTierFor(0)).toBe("weak");
  });
});

describe("weakestMetric", () => {
  it("picks the lowest of the available metrics", () => {
    expect(weakestMetric({ accuracy: 90, fluency: 60, completeness: 95, prosody: 70 })).toEqual({
      key: "fluency",
      value: 60,
    });
  });
  it("breaks ties using the fixed display order (accuracy, fluency, completeness, prosody)", () => {
    expect(weakestMetric({ accuracy: 70, fluency: 70, completeness: 95, prosody: 95 })).toEqual({
      key: "accuracy",
      value: 70,
    });
  });
  it("treats 0 as a valid, selectable value", () => {
    expect(weakestMetric({ accuracy: 0, fluency: 90, completeness: 90, prosody: 90 })).toEqual({
      key: "accuracy",
      value: 0,
    });
  });
  it("excludes missing metrics rather than treating them as 0", () => {
    expect(weakestMetric({ accuracy: undefined, fluency: 50, completeness: null, prosody: 80 })).toEqual({
      key: "fluency",
      value: 50,
    });
  });
  it("returns null when no metric has a value", () => {
    expect(weakestMetric({})).toBeNull();
  });
});

describe("feedbackFor", () => {
  it("returns a low-accuracy message when only accuracy is weak", () => {
    const scores = { accuracy: 50, fluency: 90, completeness: 95, prosody: 90 };
    const result = feedbackFor(scores, weakestMetric(scores));
    expect(result?.title).toBe("Focus on accuracy");
  });
  it("returns a low-fluency message when only fluency is weak", () => {
    const scores = { accuracy: 90, fluency: 50, completeness: 95, prosody: 90 };
    expect(feedbackFor(scores, weakestMetric(scores))?.title).toBe("Focus on fluency");
  });
  it("returns a low-completeness message when only completeness is weak", () => {
    const scores = { accuracy: 90, fluency: 90, completeness: 50, prosody: 90 };
    expect(feedbackFor(scores, weakestMetric(scores))?.title).toBe("Focus on completeness");
  });
  it("returns a low-prosody message when only prosody is weak", () => {
    const scores = { accuracy: 90, fluency: 90, completeness: 95, prosody: 50 };
    expect(feedbackFor(scores, weakestMetric(scores))?.title).toBe("Focus on prosody");
  });
  it("returns a combined message when multiple categories are weak", () => {
    const scores = { accuracy: 50, fluency: 55, completeness: 95, prosody: 90 };
    const result = feedbackFor(scores, weakestMetric(scores));
    expect(result?.title).toBe("A few areas to work on");
    expect(result?.body).toContain("accuracy");
    expect(result?.body).toContain("fluency");
  });
  it("returns a strong-result message when nothing is weak", () => {
    const scores = { accuracy: 95, fluency: 92, completeness: 100, prosody: 90 };
    expect(feedbackFor(scores, weakestMetric(scores))?.title).toBe("Strong result");
  });
  it("returns null when every metric is missing (no weakest to report)", () => {
    expect(feedbackFor({}, null)).toBeNull();
  });
});

function word(overrides: Partial<TrueEvaluationWord>): TrueEvaluationWord {
  return { word: "word", accuracyScore: 50, errorType: "Mispronunciation", ...overrides };
}

describe("currentSentenceProblemWords", () => {
  it("includes a score of exactly 0 as a valid, problem-worthy score", () => {
    const result = currentSentenceProblemWords([word({ word: "healthy", accuracyScore: 0 })]);
    expect(result).toEqual([{ word: "healthy", score: 0 }]);
  });
  it("excludes words at or above the threshold", () => {
    const result = currentSentenceProblemWords([
      word({ word: "fine", accuracyScore: 70 }),
      word({ word: "weak", accuracyScore: 69 }),
    ]);
    expect(result).toEqual([{ word: "weak", score: 69 }]);
  });
  it("excludes words with no score at all", () => {
    const result = currentSentenceProblemWords([word({ word: "nulled", accuracyScore: null })]);
    expect(result).toEqual([]);
  });
  it("strips punctuation-only tokens and edge punctuation from real words", () => {
    const result = currentSentenceProblemWords([
      word({ word: ".", accuracyScore: 10 }),
      word({ word: "livestock,", accuracyScore: 40 }),
    ]);
    expect(result).toEqual([{ word: "livestock", score: 40 }]);
  });
  it("dedupes case-insensitively, keeping one entry", () => {
    const result = currentSentenceProblemWords([
      word({ word: "Healthy", accuracyScore: 30 }),
      word({ word: "healthy", accuracyScore: 55 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].word.toLowerCase()).toBe("healthy");
  });
  it("sorts weakest first", () => {
    const result = currentSentenceProblemWords([
      word({ word: "a", accuracyScore: 65 }),
      word({ word: "b", accuracyScore: 20 }),
      word({ word: "c", accuracyScore: 40 }),
    ]);
    expect(result.map((w) => w.word)).toEqual(["b", "c", "a"]);
  });
});

function completed(overrides: Partial<TrueEvaluationResult> = {}): TrueEvaluationResult {
  return { status: "completed", pronunciationScore: 89, clipId: "clip-1", ...overrides };
}

describe("deriveEvaluationUiState", () => {
  it("is no-recording when there's no clip", () => {
    expect(
      deriveEvaluationUiState({ hasClip: false, recordingClipId: null, trueEvaluation: undefined, lastSuccessful: undefined })
    ).toBe("no-recording");
  });
  it("is recording-ready when a clip exists but nothing has ever succeeded", () => {
    expect(
      deriveEvaluationUiState({
        hasClip: true,
        recordingClipId: "clip-1",
        trueEvaluation: undefined,
        lastSuccessful: undefined,
      })
    ).toBe("recording-ready");
  });
  it("is evaluating while a request is in flight", () => {
    expect(
      deriveEvaluationUiState({
        hasClip: true,
        recordingClipId: "clip-1",
        trueEvaluation: { status: "processing" },
        lastSuccessful: undefined,
      })
    ).toBe("evaluating");
  });
  it("is success when the last successful result matches the current clip", () => {
    expect(
      deriveEvaluationUiState({
        hasClip: true,
        recordingClipId: "clip-1",
        trueEvaluation: completed(),
        lastSuccessful: completed(),
      })
    ).toBe("success");
  });
  it("is new-recording-not-evaluated when a newer clip has replaced the evaluated one", () => {
    expect(
      deriveEvaluationUiState({
        hasClip: true,
        recordingClipId: "clip-2",
        trueEvaluation: completed({ clipId: "clip-1" }),
        lastSuccessful: completed({ clipId: "clip-1" }),
      })
    ).toBe("new-recording-not-evaluated");
  });
  it("is error on a failed attempt, even with no prior success", () => {
    expect(
      deriveEvaluationUiState({
        hasClip: true,
        recordingClipId: "clip-1",
        trueEvaluation: { status: "failed", error: "boom" },
        lastSuccessful: undefined,
      })
    ).toBe("error");
  });
  it("is error on a failed retry while still carrying the previous successful result", () => {
    expect(
      deriveEvaluationUiState({
        hasClip: true,
        recordingClipId: "clip-1",
        trueEvaluation: { status: "failed", error: "boom" },
        lastSuccessful: completed({ clipId: "clip-1" }),
      })
    ).toBe("error");
  });
  it("is error for an unavailable engine, distinct from a plain failure only in status text upstream", () => {
    expect(
      deriveEvaluationUiState({
        hasClip: true,
        recordingClipId: "clip-1",
        trueEvaluation: { status: "unavailable", error: "not configured" },
        lastSuccessful: undefined,
      })
    ).toBe("error");
  });
});
