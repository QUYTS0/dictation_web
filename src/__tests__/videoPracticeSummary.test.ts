import {
  buildShadowingEvaluationSummary,
  improvementLevelFor,
  practicePriorityFor,
  toAttempt,
  trendFor,
} from "@/app/dictation/[videoId]/videoPracticeSummary";
import type { ShadowingEvaluationMap } from "@/app/dictation/[videoId]/shadowingEvaluationPersistence";
import type {
  AttemptWordScore,
  SentenceEvaluation,
  SentenceEvaluationAttempt,
  TrueEvaluationResult,
  TrueEvaluationWord,
} from "@/app/dictation/[videoId]/types";

function makeAttempt(
  evaluatedAt: string,
  pronunciationScore: number,
  words: AttemptWordScore[]
): SentenceEvaluationAttempt {
  return { evaluatedAt, pronunciationScore, accuracyScore: pronunciationScore, words };
}

/** Builds a SentenceEvaluation from an attempt history — the latest
 *  attempt's words become lastSuccessfulTrueEvaluation's words (optionally
 *  overridden with `latestWords` when a test needs phoneme detail, which
 *  the compact attempt shape never carries). */
function makeEntry(params: {
  segmentIndex: number;
  referenceText: string;
  attempts: SentenceEvaluationAttempt[];
  latestWords?: TrueEvaluationWord[];
  wordCount?: number;
}): SentenceEvaluation {
  const last = params.attempts[params.attempts.length - 1];
  const lastSuccessfulTrueEvaluation: TrueEvaluationResult = {
    status: "completed",
    evaluatedAt: last.evaluatedAt,
    pronunciationScore: last.pronunciationScore,
    accuracyScore: last.accuracyScore,
    fluencyScore: last.fluencyScore,
    completenessScore: last.completenessScore,
    prosodyScore: last.prosodyScore,
    words: params.latestWords ?? last.words.map((w) => ({ word: w.word, accuracyScore: w.accuracyScore, errorType: w.errorType })),
  };
  return {
    segmentIndex: params.segmentIndex,
    referenceText: params.referenceText,
    wordCount: params.wordCount ?? 5,
    audioDuration: 2,
    trueEvaluation: lastSuccessfulTrueEvaluation,
    lastSuccessfulTrueEvaluation,
    attempts: params.attempts,
  };
}

describe("practicePriorityFor", () => {
  it("weighs severity, error rate, and frequency per the documented formula", () => {
    // severity = 100-48 = 52; errorRate*100 = 75; frequencyFactor = min(4/3,1)*100 = 100
    // 52*0.55 + 75*0.30 + 100*0.15 = 28.6 + 22.5 + 15 = 66.1
    const priority = practicePriorityFor({ averageLatestScore: 48, errorRate: 0.75, evaluatedOccurrences: 4 });
    expect(priority).toBeCloseTo(66.1, 5);
  });

  it("ranks a severely-weak one-off word above a mildly-weak frequent one when severity dominates", () => {
    const severeOnceOff = practicePriorityFor({ averageLatestScore: 5, errorRate: 1, evaluatedOccurrences: 1 });
    const mildFrequent = practicePriorityFor({ averageLatestScore: 65, errorRate: 0.3, evaluatedOccurrences: 5 });
    expect(severeOnceOff).toBeGreaterThan(mildFrequent);
  });
});

describe("improvementLevelFor", () => {
  it("the real example: 32 -> 86 (delta 54, latest 86) is a great improvement", () => {
    expect(improvementLevelFor(54, 86)).toBe("great");
  });

  it("requires BOTH a >=30 delta AND a >=70 latest score for 'great'", () => {
    // 10 -> 35: delta 25, latest 35 — real progress, but still weak, so must
    // not be over-celebrated as "great".
    expect(improvementLevelFor(25, 35)).toBe("nice");
  });

  it("a big delta alone isn't enough for 'great' if the latest score is still low", () => {
    expect(improvementLevelFor(40, 50)).toBe("nice");
  });

  it("delta >= 20 is 'nice'", () => {
    expect(improvementLevelFor(20, 40)).toBe("nice");
  });

  it("delta >= 10 is 'improving'", () => {
    expect(improvementLevelFor(10, 40)).toBe("improving");
  });

  it("does not praise a tiny delta", () => {
    expect(improvementLevelFor(5, 90)).toBeNull();
    expect(improvementLevelFor(0, 50)).toBeNull();
  });
});

describe("trendFor", () => {
  it("32, 48, 67, 86 -> improving", () => {
    expect(trendFor([32, 48, 67, 86])).toBe("improving");
  });
  it("70, 72, 68 -> stable", () => {
    expect(trendFor([70, 72, 68])).toBe("stable");
  });
  it("82, 70, 55 -> declining", () => {
    expect(trendFor([82, 70, 55])).toBe("declining");
  });
  it("fewer than 3 points is insufficient-data, never a guess", () => {
    expect(trendFor([50, 90])).toBe("insufficient-data");
    expect(trendFor([50])).toBe("insufficient-data");
    expect(trendFor([])).toBe("insufficient-data");
  });
});

describe("toAttempt", () => {
  it("compacts a full TrueEvaluationResult down to scores + light per-word scores", () => {
    const result: TrueEvaluationResult = {
      status: "completed",
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      clipId: "clip-1",
      pronunciationScore: 82,
      accuracyScore: 80,
      words: [
        {
          word: "agriculture",
          accuracyScore: 32,
          errorType: "Mispronunciation",
          phonemes: [{ phoneme: "l", accuracyScore: 20 }],
        },
      ],
    };
    const attempt = toAttempt(result);
    expect(attempt).toEqual({
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      clipId: "clip-1",
      pronunciationScore: 82,
      accuracyScore: 80,
      fluencyScore: undefined,
      completenessScore: undefined,
      prosodyScore: undefined,
      words: [{ word: "agriculture", accuracyScore: 32, errorType: "Mispronunciation" }],
    });
  });
});

describe("buildShadowingEvaluationSummary — word history and improvement", () => {
  it("the real example: agriculture 32 -> 48 -> 67 -> 86 produces a 'great improvement' event and drops out of Words to practice once no longer flagged", () => {
    const entry = makeEntry({
      segmentIndex: 0,
      referenceText: "As crop agriculture expands, prices come down.",
      attempts: [
        makeAttempt("2026-01-01T00:00:00Z", 32, [{ word: "agriculture", accuracyScore: 32, errorType: "Mispronunciation" }]),
        makeAttempt("2026-01-01T00:01:00Z", 48, [{ word: "agriculture", accuracyScore: 48, errorType: "Mispronunciation" }]),
        makeAttempt("2026-01-01T00:02:00Z", 67, [{ word: "agriculture", accuracyScore: 67, errorType: "Mispronunciation" }]),
        makeAttempt("2026-01-01T00:03:00Z", 86, [{ word: "agriculture", accuracyScore: 86, errorType: "None" }]),
      ],
    });
    const evaluations: ShadowingEvaluationMap = { 0: entry };

    const summary = buildShadowingEvaluationSummary(evaluations, 1);

    const wordEvent = summary.improvements.find((e) => e.type === "word" && e.label === "agriculture");
    expect(wordEvent).toMatchObject({ fromScore: 32, toScore: 86, delta: 54, attemptCount: 4, level: "great" });
    // Now pronounced correctly on the latest attempt — no longer a problem word.
    expect(summary.wordsToPractice.find((w) => w.word === "agriculture")).toBeUndefined();
  });

  it("a word that improved but is still weak stays in Words to practice alongside its improvement event", () => {
    const entry = makeEntry({
      segmentIndex: 0,
      referenceText: "Sentence with a stubborn word.",
      attempts: [
        makeAttempt("2026-01-01T00:00:00Z", 20, [{ word: "crop", accuracyScore: 20, errorType: "Mispronunciation" }]),
        makeAttempt("2026-01-01T00:01:00Z", 58, [{ word: "crop", accuracyScore: 58, errorType: "Mispronunciation" }]),
      ],
    });
    const summary = buildShadowingEvaluationSummary({ 0: entry }, 1);

    expect(summary.wordsToPractice.find((w) => w.word === "crop")).toBeDefined();
    const event = summary.improvements.find((e) => e.label === "crop");
    expect(event).toMatchObject({ fromScore: 20, toScore: 58, level: "nice" });
  });

  it("marks a word mastered after recovering from a weak start", () => {
    const entry = makeEntry({
      segmentIndex: 0,
      referenceText: "Sentence.",
      attempts: [
        makeAttempt("2026-01-01T00:00:00Z", 34, [{ word: "livestock", accuracyScore: 34, errorType: "Mispronunciation" }]),
        makeAttempt("2026-01-01T00:01:00Z", 38, [{ word: "livestock", accuracyScore: 38, errorType: "Mispronunciation" }]),
        makeAttempt("2026-01-01T00:02:00Z", 45, [{ word: "livestock", accuracyScore: 45, errorType: "Mispronunciation" }]),
        makeAttempt("2026-01-01T00:03:00Z", 88, [{ word: "livestock", accuracyScore: 88, errorType: "None" }]),
      ],
    });
    const summary = buildShadowingEvaluationSummary({ 0: entry }, 1);
    const event = summary.improvements.find((e) => e.label === "livestock");
    expect(event).toMatchObject({ level: "great", mastered: true, attemptCount: 4 });
  });

  it("word events are ranked ahead of sentence events at the same level", () => {
    const wordEntry = makeEntry({
      segmentIndex: 0,
      referenceText: "Sentence one.",
      attempts: [
        makeAttempt("2026-01-01T00:00:00Z", 90, [{ word: "clear", accuracyScore: 30, errorType: "Mispronunciation" }]),
        makeAttempt("2026-01-01T00:01:00Z", 90, [{ word: "clear", accuracyScore: 90, errorType: "None" }]),
      ],
    });
    const sentenceEntry = makeEntry({
      segmentIndex: 1,
      referenceText: "Sentence two.",
      attempts: [
        makeAttempt("2026-01-01T00:00:00Z", 30, [{ word: "other", accuracyScore: 90, errorType: "None" }]),
        makeAttempt("2026-01-01T00:01:00Z", 90, [{ word: "other", accuracyScore: 90, errorType: "None" }]),
      ],
    });
    const summary = buildShadowingEvaluationSummary({ 0: wordEntry, 1: sentenceEntry }, 2);
    expect(summary.improvements[0].type).toBe("word");
    expect(summary.improvements.map((e) => e.type)).toContain("sentence");
  });

  it("does not fabricate an improvement event from a single attempt", () => {
    const entry = makeEntry({
      segmentIndex: 0,
      referenceText: "Sentence.",
      attempts: [makeAttempt("2026-01-01T00:00:00Z", 40, [{ word: "solo", accuracyScore: 40, errorType: "Mispronunciation" }])],
    });
    const summary = buildShadowingEvaluationSummary({ 0: entry }, 1);
    expect(summary.improvements).toHaveLength(0);
  });
});

describe("buildShadowingEvaluationSummary — cross-sentence word and phoneme aggregation", () => {
  it("aggregates the same word occurring in different sentences (evaluatedOccurrences, errorRate)", () => {
    const s0 = makeEntry({
      segmentIndex: 0,
      referenceText: "Livestock graze here.",
      attempts: [makeAttempt("2026-01-01T00:00:00Z", 40, [{ word: "livestock", accuracyScore: 40, errorType: "Mispronunciation" }])],
    });
    const s1 = makeEntry({
      segmentIndex: 1,
      referenceText: "More livestock over there.",
      attempts: [makeAttempt("2026-01-01T00:00:00Z", 60, [{ word: "livestock", accuracyScore: 60, errorType: "Mispronunciation" }])],
    });
    const s2 = makeEntry({
      segmentIndex: 2,
      referenceText: "Livestock again, correctly this time.",
      attempts: [makeAttempt("2026-01-01T00:00:00Z", 95, [{ word: "livestock", accuracyScore: 95, errorType: "None" }])],
    });
    const summary = buildShadowingEvaluationSummary({ 0: s0, 1: s1, 2: s2 }, 3);
    const stat = summary.wordsToPractice.find((w) => w.word === "livestock");
    expect(stat).toBeDefined();
    expect(stat?.evaluatedOccurrences).toBe(3);
    expect(stat?.mispronunciationCount).toBe(2);
    expect(stat?.errorRate).toBeCloseTo(2 / 3, 5);
    expect(stat?.segmentIndexes).toEqual([0, 1, 2]);
  });

  it("aggregates a recurring weak phoneme across different words", () => {
    const withPhoneme = (word: string, score: number, phonemeScore: number): TrueEvaluationWord[] => [
      { word, accuracyScore: score, errorType: score < 70 ? "Mispronunciation" : "None", phonemes: [{ phoneme: "l", accuracyScore: phonemeScore }] },
    ];
    const entries: ShadowingEvaluationMap = {
      0: makeEntry({
        segmentIndex: 0,
        referenceText: "Agriculture sentence.",
        attempts: [makeAttempt("2026-01-01T00:00:00Z", 36, [{ word: "agriculture", accuracyScore: 36, errorType: "Mispronunciation" }])],
        latestWords: withPhoneme("agriculture", 36, 20),
      }),
      1: makeEntry({
        segmentIndex: 1,
        referenceText: "Livestock sentence.",
        attempts: [makeAttempt("2026-01-01T00:00:00Z", 40, [{ word: "livestock", accuracyScore: 40, errorType: "Mispronunciation" }])],
        latestWords: withPhoneme("livestock", 40, 25),
      }),
      2: makeEntry({
        segmentIndex: 2,
        referenceText: "Alone sentence.",
        attempts: [makeAttempt("2026-01-01T00:00:00Z", 55, [{ word: "alone", accuracyScore: 55, errorType: "Mispronunciation" }])],
        latestWords: withPhoneme("alone", 55, 45),
      }),
    };

    const summary = buildShadowingEvaluationSummary(entries, 3);
    const lSound = summary.soundsToPractice.find((s) => s.phoneme === "l");
    expect(lSound).toBeDefined();
    expect(lSound?.weakOccurrenceCount).toBe(3);
    expect(lSound?.exampleWords.sort()).toEqual(["agriculture", "alone", "livestock"]);
  });

  it("does not count an acceptable phoneme score as a problem", () => {
    const words: TrueEvaluationWord[] = [
      { word: "fine", accuracyScore: 95, errorType: "None", phonemes: [{ phoneme: "f", accuracyScore: 90 }] },
    ];
    const entry = makeEntry({
      segmentIndex: 0,
      referenceText: "Sentence.",
      attempts: [makeAttempt("2026-01-01T00:00:00Z", 95, [{ word: "fine", accuracyScore: 95, errorType: "None" }])],
      latestWords: words,
    });
    const summary = buildShadowingEvaluationSummary({ 0: entry }, 1);
    expect(summary.soundsToPractice.find((s) => s.phoneme === "f")).toBeUndefined();
  });
});

describe("buildShadowingEvaluationSummary — retry-unbiased current state", () => {
  it("session averages reflect only the latest attempt per sentence, never every retry", () => {
    const entry = makeEntry({
      segmentIndex: 0,
      referenceText: "Sentence.",
      attempts: [
        makeAttempt("2026-01-01T00:00:00Z", 10, [{ word: "x", accuracyScore: 10, errorType: "Mispronunciation" }]),
        makeAttempt("2026-01-01T00:01:00Z", 20, [{ word: "x", accuracyScore: 20, errorType: "Mispronunciation" }]),
        makeAttempt("2026-01-01T00:02:00Z", 90, [{ word: "x", accuracyScore: 90, errorType: "None" }]),
      ],
    });
    const summary = buildShadowingEvaluationSummary({ 0: entry }, 1);
    expect(summary.weightedPronunciation).toBe(90);
    expect(summary.evaluatedCount).toBe(1);
  });
});

describe("buildShadowingEvaluationSummary — backward compatibility", () => {
  it("an old record with no `attempts` field never crashes and yields no fabricated improvement", () => {
    const oldStyleResult: TrueEvaluationResult = {
      status: "completed",
      evaluatedAt: "2026-01-01T00:00:00Z",
      pronunciationScore: 55,
      accuracyScore: 55,
      words: [{ word: "example", accuracyScore: 40, errorType: "Mispronunciation" }],
    };
    const oldEntry: SentenceEvaluation = {
      segmentIndex: 0,
      referenceText: "An old sentence.",
      wordCount: 3,
      audioDuration: 2,
      trueEvaluation: oldStyleResult,
      lastSuccessfulTrueEvaluation: oldStyleResult,
      // no `attempts` — simulates a record persisted before this field existed
    };
    const summary = buildShadowingEvaluationSummary({ 0: oldEntry }, 1);
    expect(summary.wordsToPractice.find((w) => w.word === "example")).toMatchObject({ trend: "insufficient-data" });
    expect(summary.improvements).toHaveLength(0);
  });

  it("isComplete reflects partial vs full coverage honestly", () => {
    const entry = makeEntry({
      segmentIndex: 0,
      referenceText: "Sentence.",
      attempts: [makeAttempt("2026-01-01T00:00:00Z", 90, [{ word: "ok", accuracyScore: 90, errorType: "None" }])],
    });
    expect(buildShadowingEvaluationSummary({ 0: entry }, 5).isComplete).toBe(false);
    expect(buildShadowingEvaluationSummary({ 0: entry }, 1).isComplete).toBe(true);
  });
});
