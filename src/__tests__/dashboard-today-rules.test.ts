/**
 * The Dashboard's "what's left today" rules (src/lib/dashboard/today.ts,
 * plan §4.5.9), which replaced the Next up decision: the sentences of the
 * Continue round, the Today list's rows and "All done", and unknown data
 * never read as "nothing left".
 */
import { sentencesHeadline, sentencesToReview, todayPlan, toSource, vocabularyHeadline, type Source, type TodayInputs } from "@/lib/dashboard/today";
import type { LibraryItem } from "@/lib/types/learning";

const ready = <T,>(data: T): Source<T> => ({ status: "ready", data });
const PENDING = { status: "pending" } as const;
const ERROR = { status: "error" } as const;

function item(over: Partial<LibraryItem> = {}, acc = { correct: 5, practiced: 8 }, round: Partial<NonNullable<LibraryItem["round"]>> = {}): LibraryItem {
  return {
    videoId: "v1",
    title: "Talk",
    addedAt: "2026-09-01T00:00:00Z",
    lastActivityAt: "2026-09-02T00:00:00Z",
    lastMode: "dictation",
    state: "in_progress",
    hasCompletedRound: false,
    hasLegacyCompletion: false,
    completedRoundCount: 0,
    round: {
      roundId: "r1",
      status: "active",
      provenance: "current",
      roundNumber: 1,
      transcriptId: "t",
      startedAt: "2026-09-01T00:00:00Z",
      completedAt: null,
      currentSegmentIndex: 0,
      progress: {
        requiredSentenceCount: 20,
        coveredSentences: { dictation: 8, shadowing: 0, overall: 8 },
        coverage: { dictation: 0.4, shadowing: 0, overall: 0.4 },
        attemptCount: 10,
        sentenceAccuracy: { ...acc, percent: null },
      },
      ...round,
    },
    listening: { transcriptId: "t", coverageRatio: null, listenedThrough: false, lastPositionSec: null, hasHistory: false, historyOnOtherRevision: false },
    ...over,
  };
}

const THREE = { roundId: "r1", videoId: "v1", title: "Talk", count: 3 };
const inputs = (over: Partial<TodayInputs> = {}): TodayInputs => ({
  sentences: ready(null),
  words: ready({ due: 0, reviewable: 0 }),
  wordsReviewedToday: 0,
  goalMet: false,
  ...over,
});

describe("sentencesToReview: only the Continue item's active, current round", () => {
  it("count = practiced − correct of that round", () => {
    expect(sentencesToReview(item())).toEqual(THREE);
  });
  it("none to look at again → null (no empty section)", () => {
    expect(sentencesToReview(item({}, { correct: 8, practiced: 8 }))).toBeNull();
  });
  it("legacy/unverified, completed, abandoned and round-less (Listening-only) items have none", () => {
    expect(sentencesToReview(item({}, undefined, { provenance: "legacy_unverified" }))).toBeNull();
    expect(sentencesToReview(item({}, undefined, { status: "completed" }))).toBeNull();
    expect(sentencesToReview(item({}, undefined, { status: "abandoned" }))).toBeNull();
    expect(sentencesToReview(item({ round: null, state: "listening" }))).toBeNull();
    expect(sentencesToReview(null)).toBeNull();
  });
});

describe("todayPlan: what's left today", () => {
  it("sentences first, then words (the old Next up order)", () => {
    const { rows } = todayPlan(inputs({ sentences: ready(THREE), words: ready({ due: 2, reviewable: 2 }) }));
    expect(rows).toEqual([
      { kind: "sentences", headline: "3 sentences need another look" },
      { kind: "words", done: false, headline: "2 words are due" },
    ]);
  });

  it("words: due wins over new; new-only has its own factual line", () => {
    expect(todayPlan(inputs({ words: ready({ due: 22, reviewable: 255 }) })).rows).toEqual([{ kind: "words", done: false, headline: "22 words are due" }]);
    expect(todayPlan(inputs({ words: ready({ due: 0, reviewable: 7 }) })).rows).toEqual([
      { kind: "words", done: false, headline: "New vocabulary is ready to practice" },
    ]);
  });

  it("words reviewed today and none left → a done row; none reviewed → no row", () => {
    expect(todayPlan(inputs({ wordsReviewedToday: 5 })).rows).toEqual([{ kind: "words", done: true, reviewed: 5 }]);
    expect(todayPlan(inputs({ wordsReviewedToday: 0 })).rows).toEqual([]);
    expect(todayPlan(inputs({ wordsReviewedToday: null })).rows).toEqual([]); // XP unavailable
  });

  it("all done: goal met, no sentences, words clear (reviewed or none)", () => {
    expect(todayPlan(inputs({ goalMet: true })).allDone).toBe(true);
    expect(todayPlan(inputs({ goalMet: true, wordsReviewedToday: 5 })).allDone).toBe(true);
    expect(todayPlan(inputs({ goalMet: false })).allDone).toBe(false);
    expect(todayPlan(inputs({ goalMet: true, sentences: ready(THREE) })).allDone).toBe(false);
    expect(todayPlan(inputs({ goalMet: true, words: ready({ due: 1, reviewable: 1 }) })).allDone).toBe(false);
  });

  it("unknown is never 'nothing left': a pending or failed source shows no row and blocks 'All done'", () => {
    for (const unknown of [PENDING, ERROR]) {
      expect(todayPlan(inputs({ goalMet: true, sentences: unknown })).allDone).toBe(false);
      expect(todayPlan(inputs({ goalMet: true, words: unknown })).allDone).toBe(false);
      expect(todayPlan(inputs({ sentences: unknown, words: unknown })).rows).toEqual([]);
    }
    expect(todayPlan(inputs({ goalMet: null })).allDone).toBe(false); // week unavailable
  });
});

describe("copy and sources", () => {
  it("headlines are factual; singular forms; no order or batch claims", () => {
    expect(sentencesHeadline(1)).toBe("1 sentence needs another look");
    expect(sentencesHeadline(3)).toBe("3 sentences need another look");
    expect(vocabularyHeadline("due", 1)).toBe("1 word is due");
    expect(vocabularyHeadline("new", 0)).toBe("New vocabulary is ready to practice");
  });
  it("toSource: cached data stays ready during a refetch or after a failed refetch", () => {
    expect(toSource({ data: 1, isError: true })).toEqual({ status: "ready", data: 1 });
    expect(toSource({ data: undefined, isError: true })).toEqual({ status: "error" });
    expect(toSource({ data: undefined, isError: false })).toEqual({ status: "pending" });
  });
});
