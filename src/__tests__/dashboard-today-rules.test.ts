/**
 * The Dashboard's "what's left today" rules (src/lib/dashboard/today.ts,
 * plan §4.5.9, §4.5.11), which replaced the Next up decision: the sentences
 * of the Continue round, the minutes still to practise, the Today list's rows
 * and "All done", the hero's one amber action, and unknown data never read
 * as "nothing left".
 */
import { goalToday, sentencesHeadline, sentencesToReview, todayPlan, toSource, vocabularyHeadline, type GoalToday, type Source, type TodayInputs } from "@/lib/dashboard/today";
import type { DashboardWeek, LibraryItem } from "@/lib/types/learning";

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
const MET = ready<GoalToday>({ met: true, minutesLeft: 0 });
const LEFT = (minutesLeft: number) => ready<GoalToday>({ met: false, minutesLeft });
const NEEDS = item(); // 3 sentences need another look
const CLEAN = item({}, { correct: 8, practiced: 8 });
// Default: goal met, nothing unfinished, nothing due — i.e. all done.
const inputs = (over: Partial<TodayInputs> = {}): TodayInputs => ({
  resume: ready(null),
  words: ready({ due: 0, reviewable: 0 }),
  wordsReviewedToday: 0,
  goal: MET,
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

describe("goalToday: minutes still to practise", () => {
  const week = (activeSec: number, goalMinutes = 20): DashboardWeek => ({
    timeZone: "UTC",
    today: "2026-11-25",
    weekStart: "2026-11-23",
    goalMinutes,
    goalIsDefault: false,
    days: [{ date: "2026-11-25", practiced: activeSec > 0, activeSec }],
  });
  it("rounded up, so the shown (rounded-down) minutes plus the minutes left make the goal", () => {
    expect(goalToday(week(12 * 60 + 36))).toEqual({ met: false, minutesLeft: 8 }); // shown 12 / 20
    expect(goalToday(week(0))).toEqual({ met: false, minutesLeft: 20 });
    expect(goalToday(week(20 * 60 - 1))).toEqual({ met: false, minutesLeft: 1 }); // never "0 min" to go
  });
  it("met → nothing left", () => {
    expect(goalToday(week(20 * 60))).toEqual({ met: true, minutesLeft: 0 });
    expect(goalToday(week(45 * 60))).toEqual({ met: true, minutesLeft: 0 });
  });
});

describe("todayPlan: what's left today", () => {
  it("minutes to the goal first, then sentences, then words", () => {
    const { rows } = todayPlan(inputs({ goal: LEFT(8), resume: ready(NEEDS), words: ready({ due: 2, reviewable: 2 }) }));
    expect(rows).toEqual([
      { kind: "practice", headline: "8 min to today's goal", via: "continue" },
      { kind: "sentences", headline: "3 sentences need another look" },
      { kind: "words", done: false, headline: "2 words are due" },
    ]);
  });

  it("practising needs a video: resume the unfinished one, else start one; unknown either way → no row", () => {
    expect(todayPlan(inputs({ goal: LEFT(5), resume: ready(CLEAN) })).rows).toEqual([{ kind: "practice", headline: "5 min to today's goal", via: "continue" }]);
    expect(todayPlan(inputs({ goal: LEFT(5), resume: ready(null) })).rows).toEqual([{ kind: "practice", headline: "5 min to today's goal", via: "new-video" }]);
    for (const unknown of [PENDING, ERROR]) {
      expect(todayPlan(inputs({ goal: LEFT(5), resume: unknown })).rows).toEqual([]);
      expect(todayPlan(inputs({ goal: unknown, resume: ready(CLEAN) })).rows).toEqual([]);
    }
    expect(todayPlan(inputs({ goal: MET, resume: ready(CLEAN) })).rows).toEqual([]); // goal met: nothing to add
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
    expect(todayPlan(inputs()).allDone).toBe(true);
    expect(todayPlan(inputs({ wordsReviewedToday: 5 })).allDone).toBe(true);
    expect(todayPlan(inputs({ resume: ready(CLEAN) })).allDone).toBe(true); // unfinished, but nothing to look at again
    expect(todayPlan(inputs({ goal: LEFT(3) })).allDone).toBe(false);
    expect(todayPlan(inputs({ resume: ready(NEEDS) })).allDone).toBe(false);
    expect(todayPlan(inputs({ words: ready({ due: 1, reviewable: 1 }) })).allDone).toBe(false);
  });

  it("unknown is never 'nothing left': a pending or failed source shows no row and blocks 'All done'", () => {
    for (const unknown of [PENDING, ERROR]) {
      expect(todayPlan(inputs({ resume: unknown })).allDone).toBe(false);
      expect(todayPlan(inputs({ words: unknown })).allDone).toBe(false);
      expect(todayPlan(inputs({ goal: unknown })).allDone).toBe(false); // week loading or unavailable
      expect(todayPlan(inputs({ resume: unknown, words: unknown })).rows).toEqual([]);
    }
  });
});

describe("todayPlan: the hero's one amber action", () => {
  it("something left → the first open row", () => {
    expect(todayPlan(inputs({ goal: LEFT(8), resume: ready(NEEDS) })).next).toBe("row");
    expect(todayPlan(inputs({ words: ready({ due: 2, reviewable: 2 }) })).next).toBe("row");
  });

  it("nothing left → 'Start a new video' (all done, or nothing known to do)", () => {
    expect(todayPlan(inputs()).next).toBe("new-video");
    expect(todayPlan(inputs({ wordsReviewedToday: 4 })).next).toBe("new-video"); // a ticked row is not open
    // A failed source has answered: nothing known is left, so a new video is the way on, but never "All done".
    const failed = todayPlan(inputs({ words: ERROR }));
    expect(failed.next).toBe("new-video");
    expect(failed.allDone).toBe(false);
  });

  it("still loading → nothing singled out yet (no amber hopping from row to row as sources answer)", () => {
    expect(todayPlan(inputs({ resume: PENDING, words: ready({ due: 2, reviewable: 2 }) })).next).toBeNull();
    expect(todayPlan(inputs({ goal: PENDING })).next).toBeNull();
    expect(todayPlan(inputs({ words: PENDING })).next).toBeNull();
  });
});

describe("copy and sources", () => {
  it("headlines are factual; singular forms; no order or batch claims", () => {
    expect(todayPlan(inputs({ goal: LEFT(1), resume: ready(CLEAN) })).rows[0]).toMatchObject({ headline: "1 min to today's goal" });
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
