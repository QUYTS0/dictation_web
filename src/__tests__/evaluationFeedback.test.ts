import {
  currentSentenceProblemWords,
  deriveEvaluationUiState,
  feedbackFor,
  findWord,
  focusFor,
  FOCUS_THRESHOLD,
  formatExpectedHeardLabel,
  formatWeakestSoundLabel,
  formatWeakestSyllableLabel,
  scoreTierFor,
  semanticTierFor,
  tierLabel,
  weakestMetric,
  weakestSoundFor,
  weakestSyllableFor,
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

describe("weakestSoundFor — the Expected/Heard bug fix", () => {
  it("real example: a low score with the SAME top NBest candidate must NOT fabricate a Heard phoneme", () => {
    // From a real Azure response: AccuracyScore 4 does not mean Azure heard
    // something else — its own top-ranked candidate is still /ɪ/ itself.
    const result = weakestSoundFor([
      {
        phoneme: "ɪ",
        accuracyScore: 4,
        nBestPhonemes: [
          { phoneme: "ɪ", score: 100 },
          { phoneme: "z", score: 45 },
          { phoneme: "i", score: 43 },
          { phoneme: "n", score: 29 },
          { phoneme: "ə", score: 16 },
        ],
      },
    ]);
    expect(result).toEqual({ phoneme: "ɪ", score: 4 });
    expect(result?.heardAs).toBeUndefined();
    expect(formatExpectedHeardLabel(result!)).toBeNull();
    expect(formatWeakestSoundLabel(result!)).toBe("Weakest sound: /ɪ/ · 4/100");
  });

  it("real example: a top NBest candidate that genuinely differs IS reliable evidence", () => {
    const result = weakestSoundFor([{ phoneme: "l", accuracyScore: 22, nBestPhonemes: [{ phoneme: "n", score: 100 }, { phoneme: "m", score: 42 }] }]);
    expect(result).toEqual({ phoneme: "l", score: 22, heardAs: "n" });
    expect(formatExpectedHeardLabel(result!)).toBe("Expected /l/ → Heard /n/");
    expect(formatWeakestSoundLabel(result!)).toBe("Weakest sound: /l/ · 22/100");
  });

  it("never uses a lower-ranked candidate just because the top one equals the expected phoneme", () => {
    // Old (buggy) behavior filtered the phoneme itself out of the candidate
    // list and used the best REMAINING one — which would have picked /z/
    // here (45) even though Azure's real top guess was /ɪ/ all along.
    const result = weakestSoundFor([
      { phoneme: "ɪ", accuracyScore: 4, nBestPhonemes: [{ phoneme: "ɪ", score: 100 }, { phoneme: "z", score: 90 }] },
    ]);
    expect(result?.heardAs).toBeUndefined();
  });

  it("picks the single lowest-scoring phoneme across the whole word", () => {
    const result = weakestSoundFor([
      { phoneme: "æg", accuracyScore: 32 },
      { phoneme: "ɹə", accuracyScore: 33 },
      { phoneme: "kʌl", accuracyScore: 29 },
      { phoneme: "tʃɚ", accuracyScore: 49 },
    ]);
    expect(result).toEqual({ phoneme: "kʌl", score: 29 });
  });

  it("returns null when the word has no phoneme data (older stored evaluations)", () => {
    expect(weakestSoundFor(undefined)).toBeNull();
  });
});

describe("weakestSyllableFor", () => {
  it("picks the lowest-scoring syllable and its grapheme", () => {
    const result = weakestSyllableFor([
      { syllable: "æg", grapheme: "ag", accuracyScore: 32 },
      { syllable: "kʌl", grapheme: "cul", accuracyScore: 29 },
    ]);
    expect(result).toEqual({ syllable: "kʌl", grapheme: "cul", score: 29 });
    expect(formatWeakestSyllableLabel(result!)).toBe("Weakest part: cul · /kʌl/ · 29/100");
  });

  it("formats without a grapheme when Azure didn't return one", () => {
    const result = weakestSyllableFor([{ syllable: "kʌl", accuracyScore: 29 }]);
    expect(formatWeakestSyllableLabel(result!)).toBe("Weakest part: /kʌl/ · 29/100");
  });

  it("returns null for older stored evaluations with no syllable data", () => {
    expect(weakestSyllableFor(undefined)).toBeNull();
  });
});

describe("findWord", () => {
  it("finds a word by display text, ignoring edge punctuation and case", () => {
    const words = [word({ word: "livestock," })];
    expect(findWord(words, "livestock")).toBe(words[0]);
    expect(findWord(words, "LIVESTOCK")).toBe(words[0]);
  });

  it("returns undefined when nothing matches", () => {
    expect(findWord([word({ word: "cat" })], "dog")).toBeUndefined();
  });
});

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

describe("FOCUS_THRESHOLD", () => {
  it("is 70, and both consumers that used to be separate constants fire at the same boundary", () => {
    expect(FOCUS_THRESHOLD).toBe(70);
    // currentSentenceProblemWords' default threshold
    expect(currentSentenceProblemWords([{ word: "a", accuracyScore: 69, errorType: "Mispronunciation" }])).toEqual([
      { word: "a", score: 69 },
    ]);
    expect(currentSentenceProblemWords([{ word: "a", accuracyScore: 70, errorType: "Mispronunciation" }])).toEqual([]);
    // feedbackFor's low-metric trigger
    expect(feedbackFor({ accuracy: 69, fluency: 90, completeness: 90, prosody: 90 }, { key: "accuracy", value: 69 })?.title).toBe(
      "Focus on accuracy"
    );
    expect(feedbackFor({ accuracy: 70, fluency: 90, completeness: 90, prosody: 90 }, { key: "accuracy", value: 70 })?.title).toBe(
      "Strong result"
    );
  });
});

describe("focusFor", () => {
  const strongScores = { accuracy: 95, fluency: 92, completeness: 100, prosody: 90 };

  it("prioritizes a weak word over a weak metric — never 'Strong result' while a word is flagged", () => {
    const scores = { accuracy: 95, fluency: 40, completeness: 100, prosody: 90 }; // fluency is also weak
    const words = [word({ word: "agriculture", accuracyScore: 41, errorType: "Mispronunciation" })];
    expect(focusFor(scores, words)).toEqual({
      kind: "word",
      word: "agriculture",
      errorType: "Mispronunciation",
      score: 41,
      coaching: "Say it again with clearer pronunciation.",
    });
  });

  it("shows a structured Weakest sound (no coaching prose) when phoneme data is available but no Heard evidence exists", () => {
    const words = [
      word({
        word: "expands",
        accuracyScore: 41,
        errorType: "Mispronunciation",
        phonemes: [
          { phoneme: "ɪk", accuracyScore: 92 },
          { phoneme: "spændz", accuracyScore: 37 },
        ],
      }),
    ];
    expect(focusFor(strongScores, words)).toEqual({
      kind: "word",
      word: "expands",
      errorType: "Mispronunciation",
      score: 41,
      weakestSound: { phoneme: "spændz", score: 37 },
    });
  });

  it("shows Expected/Heard only when Azure's own top NBest candidate genuinely differs (real /l/→/n/ example)", () => {
    const words = [
      word({
        word: "agriculture",
        accuracyScore: 36,
        errorType: "Mispronunciation",
        phonemes: [{ phoneme: "l", accuracyScore: 22, nBestPhonemes: [{ phoneme: "n", score: 100 }, { phoneme: "m", score: 42 }] }],
      }),
    ];
    expect(focusFor(strongScores, words)).toEqual({
      kind: "word",
      word: "agriculture",
      errorType: "Mispronunciation",
      score: 36,
      weakestSound: { phoneme: "l", score: 22, heardAs: "n" },
    });
  });

  it("never fabricates Expected/Heard when the top NBest candidate equals the expected phoneme (real /ɪ/ example, score 4)", () => {
    const words = [
      word({
        word: "it",
        accuracyScore: 40,
        errorType: "Mispronunciation",
        phonemes: [
          {
            phoneme: "ɪ",
            accuracyScore: 4,
            nBestPhonemes: [
              { phoneme: "ɪ", score: 100 },
              { phoneme: "z", score: 45 },
              { phoneme: "i", score: 43 },
              { phoneme: "n", score: 29 },
              { phoneme: "ə", score: 16 },
            ],
          },
        ],
      }),
    ];
    const result = focusFor(strongScores, words);
    expect(result).toEqual({
      kind: "word",
      word: "it",
      errorType: "Mispronunciation",
      score: 40,
      weakestSound: { phoneme: "ɪ", score: 4 },
    });
    expect(result?.kind === "word" && result.weakestSound?.heardAs).toBeUndefined();
  });

  it("surfaces a sentence-wide break issue only once no word is flagged on accuracy", () => {
    const words = [
      word({ word: "there", accuracyScore: 95, errorType: "None" }),
      {
        ...word({ word: "are", accuracyScore: 95, errorType: "None" }),
        prosodyFeedback: { breakErrorType: "MissingBreak" as const },
      },
    ];
    expect(focusFor(strongScores, words)).toEqual({
      kind: "word",
      word: "are",
      errorType: "Missing break",
      coaching: "Add a short pause here.",
    });
  });

  it("surfaces Monotone only when no word issue and no break issue were found", () => {
    const words = [
      {
        ...word({ word: "there", accuracyScore: 95, errorType: "None" }),
        prosodyFeedback: { intonationErrorType: "Monotone" as const },
      },
    ];
    expect(focusFor(strongScores, words)).toEqual({
      kind: "word",
      word: "there",
      errorType: "Monotone",
      coaching: "Use more pitch variation and stress the key words.",
    });
  });

  it("falls back to a single weak metric when no word or prosody issue is flagged", () => {
    const scores = { accuracy: 95, fluency: 50, completeness: 100, prosody: 90 };
    expect(focusFor(scores, [])).toEqual({
      kind: "metric",
      key: "fluency",
      title: "Focus on fluency",
      body: expect.any(String),
    });
  });

  it("uses the combined multi-metric template when several metrics are weak", () => {
    const scores = { accuracy: 50, fluency: 55, completeness: 100, prosody: 90 };
    const result = focusFor(scores, []);
    expect(result?.kind).toBe("metric");
    if (result?.kind === "metric") {
      expect(result.title).toBe("A few areas to work on");
    }
  });

  it("returns a strong-result message when nothing is weak", () => {
    expect(focusFor(strongScores, [])).toEqual({ kind: "strong", message: expect.any(String) });
  });

  it("returns null when there are no words and no metrics at all", () => {
    expect(focusFor({}, [])).toBeNull();
  });

  it("falls through to strong when a word scored exactly at the threshold isn't flagged", () => {
    // A word scored exactly 70 is excluded by currentSentenceProblemWords
    // (threshold is exclusive), so focusFor never sees it as a problem word.
    const words = [word({ word: "fine", accuracyScore: 70, errorType: "Mispronunciation" })];
    expect(focusFor(strongScores, words)).toEqual({ kind: "strong", message: expect.any(String) });
  });
});
