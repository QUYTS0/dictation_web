/**
 * The shared Shadowing round summary (src/lib/practice/shadowingSummary.ts):
 * coverage, occurrence-level word evidence, error-type classification,
 * comparable-only improvement, detail availability, display rounding, and
 * parity between the practice page's live adapter and the reports' server
 * adapter. Pure — no network, no Azure.
 */
import {
  SHADOWING_SUMMARY_RULES,
  buildShadowingRoundSummary,
  improvementLevelFor,
  normalizeWordKey,
  practicePriorityFor,
  type ShadowingSummaryInput,
  type SummaryHistoryInput,
  type SummarySentenceInput,
  type SummaryWordInput,
} from "@/lib/practice/shadowingSummary";
import { formatAggregateScore, roundAggregateScore } from "@/lib/practice/scoreFormat";
import { fromRoundResults } from "@/lib/practice/shadowingSummaryInput";
import { mergeServerResults } from "@/app/dictation/[videoId]/shadowingServerMerge";
import { summaryInputFromEvaluations } from "@/app/dictation/[videoId]/videoPracticeSummary";
import type { ShadowingAttemptDto, ShadowingRoundResults, ShadowingSegmentResults } from "@/lib/practice/shadowingTypes";

const w = (word: string, accuracyScore: number | null, errorType = "None", extra: Partial<SummaryWordInput> = {}): SummaryWordInput => ({
  word,
  accuracyScore,
  errorType,
  ...extra,
});

function sentence(
  segmentIndex: number,
  referenceText: string,
  words: SummaryWordInput[] | null,
  over: Partial<SummarySentenceInput> & { pron?: number; createdAt?: string } = {}
): SummarySentenceInput {
  const createdAt = over.createdAt ?? `2026-09-01T10:${String(segmentIndex).padStart(2, "0")}:00Z`;
  const pron = over.pron ?? 80;
  return {
    segmentIndex,
    referenceText,
    wordCount: referenceText.split(/\s+/).length,
    audioDurationSec: 2,
    representative: {
      attemptId: `a${segmentIndex}`,
      recordingCreatedAt: createdAt,
      evaluatedAt: createdAt,
      scores: { pronunciation: pron, accuracy: pron, fluency: pron, completeness: pron, prosody: pron },
      words,
    },
    history: [{ attemptId: `a${segmentIndex}`, recordingCreatedAt: createdAt, evaluatedAt: createdAt, pronunciationScore: pron, words }],
    wordMatch: null,
    ...over,
  };
}
const build = (sentences: SummarySentenceInput[], eligible: number | null = 10, recorded: number | null = sentences.length) =>
  buildShadowingRoundSummary({ eligibleSentences: eligible, recordedSentences: recorded, sentences });

// ---------------------------------------------------------------- rules / helpers

describe("rules and helpers", () => {
  it("word key: lowercase, edge punctuation stripped, internal apostrophes/hyphens kept, no stemming", () => {
    expect(normalizeWordKey("Don’t,")).toBe("don't");
    expect(normalizeWordKey("“Well-known.”")).toBe("well-known");
    expect(normalizeWordKey("Cats")).toBe("cats");
    expect(normalizeWordKey("—")).toBeNull();
  });

  it("priority formula and improvement levels (a decline or a small change is never an improvement)", () => {
    expect(practicePriorityFor({ averageScore: 40, errorRate: 0.5, affectedSentences: 3 })).toBeCloseTo(60 * 0.55 + 50 * 0.3 + 100 * 0.15);
    expect(improvementLevelFor(54, 86)).toBe("great");
    expect(improvementLevelFor(35, 60)).toBe("nice");
    expect(improvementLevelFor(10, 50)).toBe("improving");
    expect(improvementLevelFor(9, 90)).toBeNull();
    expect(improvementLevelFor(0, 90)).toBeNull();
    expect(improvementLevelFor(-30, 40)).toBeNull();
  });
});

// ---------------------------------------------------------------- coverage

describe("coverage (D1)", () => {
  it("scored, recorded and Word Match are separate counts over the ELIGIBLE sentences", () => {
    const s = build(
      [
        sentence(0, "one two", [w("one", 90), w("two", 90)]),
        sentence(1, "three four", [w("three", 90), w("four", 90)]),
        sentence(2, "five six", [w("five", 90), w("six", 90)], { wordMatch: { accuracy: 100, completeness: 100 } }),
        { ...sentence(3, "seven eight", null), representative: null, history: [], wordMatch: { accuracy: 50, completeness: 50 } },
      ],
      6,
      5
    );
    expect(s.coverage).toEqual({
      eligibleSentences: 6,
      recordedSentences: 5,
      scoredSentences: 3,
      wordMatchSentences: 2,
      allRecorded: false,
      allScored: false,
    });
  });

  it("all sentences recorded but only partly scored stays partial; unknown/zero denominators never claim completion", () => {
    const one = [sentence(0, "one two", [w("one", 90), w("two", 90)])];
    expect(build(one, 3, 3).coverage).toMatchObject({ allRecorded: true, allScored: false });
    expect(build(one, 1, 1).coverage).toMatchObject({ allRecorded: true, allScored: true });
    expect(build(one, null, 1).coverage).toMatchObject({ allRecorded: false, allScored: false });
    expect(build([], 0, 0).coverage).toMatchObject({ allRecorded: false, allScored: false });
  });
});

// ---------------------------------------------------------------- metrics

describe("metrics (weights, missing values)", () => {
  it("word-count / duration weights; a missing metric is excluded — never 0, never Word Match", () => {
    const a = sentence(0, "a b", [w("a", 90)], { pron: 80 });
    const b = { ...sentence(1, "c d e", [w("c", 90)], { pron: 70 }), audioDurationSec: 3 };
    const c = sentence(2, "f g", [w("f", 90)], { pron: 90, wordMatch: { accuracy: 100, completeness: 100 } });
    c.representative!.scores.fluency = null;
    c.representative!.scores.prosody = null;
    const s = build([a, b, c]);
    expect(s.metrics.pronunciation).toEqual({ value: (80 * 2 + 70 * 3 + 90 * 2) / 7, sentences: 3 });
    expect(s.metrics.fluency).toEqual({ value: (80 * 2 + 70 * 3) / 5, sentences: 2 });
    expect(s.metrics.prosody?.sentences).toBe(2);
    expect(s.wordMatchAccuracy).toEqual({ value: 100, sentences: 1 });
  });
});

// ---------------------------------------------------------------- occurrences

describe("occurrence-level word evidence (D2)", () => {
  it("a weak SECOND occurrence of a word in one sentence is kept, and the word is never 'well pronounced'", () => {
    const s = build([sentence(0, "The cat saw the dog.", [w("The", 95), w("cat", 92), w("saw", 92), w("the", 30, "Mispronunciation"), w("dog.", 92)])]);
    const the = s.priorities.find((p) => p.key === "the");
    expect(the).toMatchObject({ occurrences: 2, affectedOccurrences: 1, sentences: 1, affectedSentences: 1, recurring: false });
    expect(the?.averageScore).toBeCloseTo((95 + 30) / 2);
    expect(the?.examples).toEqual([{ segmentIndex: 0, position: 3, attemptId: "a0", word: "the", score: 30 }]);
    expect(s.wellPronounced.map((x) => x.word.toLowerCase())).not.toContain("the");
  });

  it("occurrence counts and sentence counts stay distinct: 3 flagged occurrences across 2 sentences", () => {
    const s = build([
      sentence(0, "the end the end", [w("the", 40), w("end", 90), w("the", 45), w("end", 90)]),
      sentence(1, "to the sea", [w("to", 90), w("the", 50), w("sea", 90)]),
    ]);
    const the = s.priorities.find((p) => p.key === "the")!;
    expect(the).toMatchObject({ occurrences: 3, affectedOccurrences: 3, sentences: 2, affectedSentences: 2, recurring: true, lowScoreOccurrences: 3 });
  });

  it("ranking: recurring first, then priority, then affected occurrences, then the word; initial view shows 5", () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
    const s = build([
      sentence(0, words.join(" "), words.map((x, i) => w(x, 20 + i * 5))),
      sentence(1, "golf hotel", [w("golf", 55), w("hotel", 95)]),
    ]);
    expect(s.priorities[0].key).toBe("golf"); // the only recurring one, although not the weakest
    expect(s.priorities.slice(1).map((p) => p.key)).toEqual(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]);
    expect(SHADOWING_SUMMARY_RULES.INITIAL_PRIORITIES).toBe(5);
  });
});

describe("error classification (D4)", () => {
  it("omission (numeric 0 or null), insertion and prosody types are never pronunciation priorities", () => {
    const s = build([
      sentence(0, "I saw the other cat today", [
        w("I", 90),
        w("saw", 90),
        w("the", 0, "Omission"),
        w("other", null, "Omission"),
        w("uh", 10, "Insertion"),
        w("cat", 20, "UnexpectedBreak"),
        w("today", 85, "None", { prosodyFeedback: { breakErrorType: "MissingBreak" } }),
      ]),
    ]);
    expect(s.priorities).toEqual([]);
    expect(s.notRecognized.map((g) => g.key)).toEqual(["other", "the"]);
    expect(s.extraWords.map((g) => g.key)).toEqual(["uh"]);
    expect(s.rhythm.map((r) => [r.type, r.occurrences]).sort()).toEqual([
      ["MissingBreak", 1],
      ["UnexpectedBreak", 1],
    ]);
    // A rhythm flag rules out "well pronounced", even with a high score.
    expect(s.wellPronounced.map((x) => x.word)).not.toContain("today");
  });

  it("mispronunciation without a score is still pronunciation evidence (ranked at the threshold); unknown types stay uncertain", () => {
    const s = build([sentence(0, "big red bus", [w("big", null, "Mispronunciation"), w("red", 70, "SomethingNew"), w("bus", null)])]);
    expect(s.priorities).toHaveLength(1);
    expect(s.priorities[0]).toMatchObject({ key: "big", averageScore: null, mispronouncedOccurrences: 1 });
    expect(s.priorities[0].priority).toBeCloseTo(practicePriorityFor({ averageScore: SHADOWING_SUMMARY_RULES.LOW_WORD_SCORE, errorRate: 1, affectedSentences: 1 }));
    expect(s.detail.uncertainOccurrences).toBe(2);
    expect(s.wellPronounced).toEqual([]); // missing observations are not successes
  });

  it("sounds: phonemes of pronunciation words only; the average covers LOW observations and says so", () => {
    const ph = (pairs: Array<[string, number]>) => pairs.map(([phoneme, accuracyScore]) => ({ phoneme, accuracyScore }));
    const s = build([
      sentence(0, "think three", [w("think", 40, "None", { phonemes: ph([["θ", 30], ["ɪ", 90]]) }), w("three", 80, "None", { phonemes: ph([["θ", 50]]) })]),
      sentence(1, "thin", [w("thin", 90, "Omission", { phonemes: ph([["θ", 10]]) })]),
    ]);
    expect(s.sounds).toEqual([
      { phoneme: "θ", observations: 2, lowObservations: 2, averageLowScore: 40, lowestScore: 30, affectedSentences: 1, exampleWords: ["think", "three"] },
    ]);
  });
});

// ---------------------------------------------------------------- improvement

const hist = (id: string, at: string, pron: number, words: SummaryHistoryInput["words"]): SummaryHistoryInput => ({
  attemptId: id,
  recordingCreatedAt: at,
  evaluatedAt: at,
  pronunciationScore: pron,
  words,
});

describe("comparable-only improvement (D3)", () => {
  it("the same word in different sentences never produces an improvement", () => {
    const s = build([
      sentence(0, "Water is wet.", [w("Water", 30, "Mispronunciation"), w("is", 90), w("wet.", 90)]),
      sentence(5, "Drink the water.", [w("Drink", 90), w("the", 90), w("water.", 92)]),
    ]);
    expect(s.wordImprovements).toEqual([]);
    expect(s.sentenceImprovements).toEqual([]);
    expect(s.priorities.map((p) => p.key)).toEqual(["water"]);
  });

  it("same sentence, aligned results: word and sentence improvement, labelled since the first result when history is complete", () => {
    const words1 = [{ word: "Agriculture", accuracyScore: 32, errorType: "Mispronunciation" }, { word: "matters.", accuracyScore: 80, errorType: "None" }];
    const words2 = [{ word: "Agriculture", accuracyScore: 86, errorType: "None" }, { word: "matters.", accuracyScore: 82, errorType: "None" }];
    const s0 = sentence(0, "Agriculture matters.", words2.map((x) => w(x.word, x.accuracyScore)), { pron: 84 });
    s0.history = [hist("a-new", "2026-09-01T11:00:00Z", 84, words2), hist("a-old", "2026-09-01T10:00:00Z", 50, words1)];
    const s = build([s0]);
    expect(s.wordImprovements).toEqual([
      expect.objectContaining({ kind: "word", word: "Agriculture", position: 0, fromScore: 32, toScore: 86, level: "great", sinceFirstResult: true, resultsCompared: 2 }),
    ]);
    expect(s.sentenceImprovements).toEqual([expect.objectContaining({ kind: "sentence", fromScore: 50, toScore: 84, level: "great", sinceFirstResult: true })]);
  });

  it("a full (capped) history is a 'recent' comparison, not 'since the first'", () => {
    const words = [{ word: "go", accuracyScore: 90, errorType: "None" }];
    const s0 = sentence(0, "go", [w("go", 90)], { pron: 90 });
    s0.history = [50, 60, 70, 80, 90].map((p, i) => hist(`h${i}`, `2026-09-01T1${i}:00:00Z`, p, words));
    expect(build([s0]).sentenceImprovements[0]).toMatchObject({ fromScore: 50, toScore: 90, sinceFirstResult: false, resultsCompared: 5 });
  });

  it("ambiguity suppresses word improvement: repeated word, omission/insertion, or words that don't match the sentence", () => {
    const run = (ref: string, oldWords: SummaryHistoryInput["words"], newWords: SummaryHistoryInput["words"]) => {
      const s0 = sentence(0, ref, newWords!.map((x) => w(x.word, x.accuracyScore, x.errorType)), { pron: 90 });
      s0.history = [hist("old", "2026-09-01T10:00:00Z", 50, oldWords), hist("new", "2026-09-01T11:00:00Z", 90, newWords)];
      return build([s0]);
    };
    const W = (word: string, accuracyScore: number, errorType = "None") => ({ word, accuracyScore, errorType });
    // repeated "the": no word claim for it; the unique word still compares
    const rep = run("the cat the dog", [W("the", 20), W("cat", 30), W("the", 20), W("dog", 90)], [W("the", 90), W("cat", 90), W("the", 90), W("dog", 90)]);
    expect(rep.wordImprovements.map((x) => x.word)).toEqual(["cat"]);
    // an omission in the old result shifts nothing we can trust → no word claims
    expect(run("a big cat", [W("a", 90), W("big", 0, "Omission"), W("cat", 20)], [W("a", 90), W("big", 90), W("cat", 90)]).wordImprovements).toEqual([]);
    // an insertion in the new result → no word claims
    expect(run("a cat", [W("a", 30), W("cat", 20)], [W("a", 90), W("uh", 50, "Insertion"), W("cat", 90)]).wordImprovements).toEqual([]);
    // Azure tokens that don't match the reference words → no word claims; the sentence comparison remains
    const mismatch = run("in 1990", [W("in", 20), W("nineteen", 20), W("ninety", 20)], [W("in", 90), W("nineteen", 90), W("ninety", 90)]);
    expect(mismatch.wordImprovements).toEqual([]);
    expect(mismatch.sentenceImprovements).toHaveLength(1);
  });

  it("a decline or an unchanged score is never an improvement", () => {
    const words = [{ word: "go", accuracyScore: 50, errorType: "None" }];
    for (const [from, to] of [[90, 60], [70, 70]]) {
      const s0 = sentence(0, "go", [w("go", 50)], { pron: to });
      s0.history = [hist("old", "2026-09-01T10:00:00Z", from, words), hist("new", "2026-09-01T11:00:00Z", to, words)];
      const s = build([s0]);
      expect([s.sentenceImprovements, s.wordImprovements]).toEqual([[], []]);
    }
  });
});

// ---------------------------------------------------------------- detail availability

describe("detail availability (D5)", () => {
  it("no scores / no word detail / partial / full are distinguished; missing detail keeps the score in the averages", () => {
    expect(build([]).detail.availability).toBe("no_scores");
    const none = build([sentence(0, "one two", null, { pron: 40 })]);
    expect(none.detail).toMatchObject({ availability: "none", scoredWithWordDetail: 0, scoredWithoutWordDetail: 1 });
    expect(none.metrics.pronunciation?.value).toBe(40);
    expect(none.priorities).toEqual([]);
    const partial = build([sentence(0, "one two", null), sentence(1, "three four", [w("three", 30), w("four", 90)])]);
    expect(partial.detail).toMatchObject({ availability: "partial", scoredWithWordDetail: 1, scoredWithoutWordDetail: 1, scoredWithPhonemeDetail: 0 });
    expect(build([sentence(0, "one two", [w("one", 90), w("two", 90)])]).detail.availability).toBe("full");
  });
});

// ---------------------------------------------------------------- rounding

describe("one display rounding rule (D6)", () => {
  it("one decimal, half away from zero, like round(…, 1) — including float noise around the boundary", () => {
    expect(formatAggregateScore((84 * 11 + 85 * 9) / 20)).toBe("84.5"); // exact mean 84.45
    expect(formatAggregateScore(84.4499999999999)).toBe("84.5"); // float noise of 84.45
    expect(formatAggregateScore(84.449)).toBe("84.4");
    expect(formatAggregateScore(84.4501)).toBe("84.5");
    expect(formatAggregateScore(84.35)).toBe("84.4");
    expect(formatAggregateScore(99.95)).toBe("100.0");
    expect(formatAggregateScore(0.05)).toBe("0.1");
    expect(formatAggregateScore(78.6)).toBe("78.6"); // a server value formats unchanged
    expect(formatAggregateScore(null)).toBe("—");
    expect(roundAggregateScore(550 / 7)).toBe(78.6);
  });
});

// ---------------------------------------------------------------- adapters

function dto(seg: number, id: string, createdAt: string, azure: Partial<ShadowingAttemptDto["azure"]> = {}, wordMatch: Partial<ShadowingAttemptDto["wordMatch"]> = {}): ShadowingAttemptDto {
  return {
    attemptId: id, clientAttemptId: `c-${id}`, roundId: "r", youtubeVideoId: "v", transcriptId: "t", segmentIndex: seg, createdAt,
    recordingDurationSec: 3, isPracticeValid: true, validityBasis: "client_reported", studySessionId: "s1",
    azure: { status: "not_evaluated", seq: 0, requestedAt: null, evaluatedAt: null, pronunciationScore: null, accuracyScore: null, fluencyScore: null,
      completenessScore: null, prosodyScore: null, errorReason: null, engineVersion: null, detail: null, ...azure },
    wordMatch: { status: null, seq: 0, accuracy: null, completeness: null, evaluatedAt: null, detail: null, ...wordMatch },
  };
}

describe("live and server adapters agree (same saved data → same input and summary)", () => {
  it("restored page state and the report's server read produce identical summaries", () => {
    const TEXTS = ["The cat saw the dog.", "Think three times.", "Seven eight."];
    const ok = (at: string, pron: number, words: unknown[]) => ({
      status: "completed" as const, seq: 1, evaluatedAt: at, pronunciationScore: pron, accuracyScore: pron, fluencyScore: pron, completenessScore: pron, prosodyScore: null,
      detail: { recognizedText: "x", words: words as never },
    });
    const w0 = [w("The", 95), w("cat", 92), w("saw", 92), w("the", 30, "Mispronunciation"), w("dog.", 92)];
    const w1 = [w("Think", 40, "None", { phonemes: [{ phoneme: "θ", accuracyScore: 30 }] }), w("three", 70), w("times.", 0, "Omission")];
    const older = dto(0, "a0-old", "2026-09-01T09:00:00Z", ok("2026-09-01T09:00:05Z", 50, w0.map((x) => ({ ...x, accuracyScore: 20 }))));
    const s0 = dto(0, "a0", "2026-09-01T10:00:00Z", ok("2026-09-01T10:00:05Z", 80, w0));
    const s1 = dto(1, "a1", "2026-09-01T10:01:00Z", ok("2026-09-01T10:01:05Z", 60, w1), { status: "completed", seq: 1, accuracy: 70, completeness: 70 });
    const s2 = dto(2, "a2", "2026-09-01T10:02:00Z", {}, { status: "completed", seq: 1, accuracy: 50, completeness: 50 });
    const history = (ds: ShadowingAttemptDto[]) =>
      ds.map((d) => ({ attemptId: d.attemptId, createdAt: d.createdAt, evaluatedAt: d.azure.evaluatedAt, pronunciationScore: d.azure.pronunciationScore,
        accuracyScore: d.azure.accuracyScore, fluencyScore: null, completenessScore: null, prosodyScore: null,
        words: ((d.azure.detail?.words ?? []) as SummaryWordInput[]).map(({ word, accuracyScore, errorType }) => ({ word, accuracyScore, errorType })) }));
    const segments: ShadowingSegmentResults[] = [
      { segmentIndex: 0, attemptCount: 2, latestAttempt: s0, latestSuccessfulAzureAttempt: s0, latestWordMatchAttempt: null, azureHistory: history([older, s0]) },
      { segmentIndex: 1, attemptCount: 1, latestAttempt: s1, latestSuccessfulAzureAttempt: s1, latestWordMatchAttempt: s1, azureHistory: history([s1]) },
      { segmentIndex: 2, attemptCount: 1, latestAttempt: s2, latestSuccessfulAzureAttempt: null, latestWordMatchAttempt: s2, azureHistory: [] },
    ];
    const results: ShadowingRoundResults = { roundId: "r", youtubeVideoId: "v", transcriptId: "t", roundStatus: "active", evaluationTimeoutSec: 120, segments };
    const counts = { eligibleSentences: 6, recordedSentences: 3 };
    const fromServer = fromRoundResults(results, (i) => TEXTS[i], counts);
    const fromLive = summaryInputFromEvaluations(mergeServerResults({}, results, (i) => TEXTS[i]), counts);
    const sort = (x: ShadowingSummaryInput) => ({ ...x, sentences: [...x.sentences].sort((a, b) => a.segmentIndex - b.segmentIndex) });
    expect(sort(fromLive)).toEqual(sort(fromServer));
    const summary = buildShadowingRoundSummary(fromServer);
    expect(buildShadowingRoundSummary(fromLive)).toEqual(summary);
    expect(summary.coverage).toMatchObject({ scoredSentences: 2, wordMatchSentences: 2, eligibleSentences: 6, recordedSentences: 3 });
    expect(summary.priorities.map((p) => p.key)).toEqual(["think", "the"]);
    expect(summary.notRecognized.map((g) => g.key)).toEqual(["times"]);
  });
});
