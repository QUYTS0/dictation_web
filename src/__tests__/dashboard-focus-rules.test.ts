/**
 * Dashboard Focus V1 — the pure decision (selectFocus). Progressive priority:
 * sentences → vocabulary → add-video → hidden; each rule waits only for the
 * sources it needs; errors are never read as "nothing to do".
 */
import { focusCandidate, selectFocus, toFocusSource, type FocusInputs, type FocusSource } from "@/lib/dashboard/selectFocus";
import type { DashboardSummary, LibraryItem } from "@/lib/types/learning";
import type { VocabularyStatsResponse } from "@/lib/types";

const ready = <T,>(data: T): FocusSource<T> => ({ status: "ready", data });
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
const stats = (over: Partial<VocabularyStatsResponse> = {}): VocabularyStatsResponse => ({ total: 10, new: 0, learning: 10, due: 0, reviewable: 0, ...over });
const summary = (over: Partial<DashboardSummary> = {}) => ({ libraryVideos: 3, vocabularyCount: 10, ...over }) as DashboardSummary;

const inputs = (over: Partial<FocusInputs> = {}): FocusInputs => ({
  continueItems: ready([item()]),
  vocab: ready(stats()),
  summary: ready(summary()),
  ...over,
});

describe("candidate: only the top Continue item's active, current round", () => {
  it("needsReview = practiced − correct of that round", () => {
    expect(focusCandidate([item()])).toEqual({ roundId: "r1", videoId: "v1", title: "Talk", needsReview: 3 });
  });
  it("legacy/unverified, completed, abandoned and round-less (Listening-only) tops are not candidates", () => {
    expect(focusCandidate([item({}, undefined, { provenance: "legacy_unverified" })])).toBeNull();
    expect(focusCandidate([item({}, undefined, { status: "completed" })])).toBeNull();
    expect(focusCandidate([item({}, undefined, { status: "abandoned" })])).toBeNull();
    expect(focusCandidate([item({ round: null, state: "listening" })])).toBeNull();
    expect(focusCandidate([])).toBeNull();
  });
  it("later Continue items are never inspected", () => {
    const top = item({ videoId: "top", round: null, state: "listening" });
    const second = item({ videoId: "second" }, { correct: 0, practiced: 9 });
    expect(focusCandidate([top, second])).toBeNull();
    expect(selectFocus(inputs({ continueItems: ready([top, second]) }))).toEqual({ kind: "hidden", reason: "nothing-actionable" });
  });
});

describe("progressive priority", () => {
  it("1. Continue unresolved → pending, even when vocabulary and summary are ready", () => {
    expect(selectFocus(inputs({ continueItems: PENDING, vocab: ready(stats({ due: 4, reviewable: 4 })) }))).toEqual({ kind: "pending" });
  });
  it("3. sentences win immediately — vocabulary and summary may still be pending or failed", () => {
    for (const vocab of [PENDING, ERROR] as const) {
      for (const s of [PENDING, ERROR] as const) {
        expect(selectFocus(inputs({ vocab, summary: s }))).toEqual({ kind: "sentences", roundId: "r1", videoId: "v1", title: "Talk", needsReview: 3 });
      }
    }
  });
  it("4. no sentence action and vocabulary unresolved → pending (no lower-priority flash)", () => {
    const clean = ready([item({}, { correct: 8, practiced: 8 })]);
    expect(selectFocus(inputs({ continueItems: clean, vocab: PENDING, summary: ready(summary({ libraryVideos: 0 })) }))).toEqual({ kind: "pending" });
  });
  it("5. vocabulary due wins (22 due, 233 new → due, not new) without waiting for the summary", () => {
    const clean = ready([item({}, { correct: 8, practiced: 8 })]);
    expect(selectFocus(inputs({ continueItems: clean, vocab: ready(stats({ due: 22, new: 233, reviewable: 255 })), summary: PENDING }))).toEqual({
      kind: "vocabulary",
      variant: "due",
      due: 22,
      newCount: 233,
      reviewable: 255,
    });
  });
  it("5. new-only vocabulary (due 0, reviewable > 0, new > 0)", () => {
    const clean = ready([]);
    expect(selectFocus(inputs({ continueItems: clean, vocab: ready(stats({ new: 7, reviewable: 7 })) }))).toMatchObject({ kind: "vocabulary", variant: "new", newCount: 7 });
  });
  it("6. no sentence/vocabulary action and summary unresolved → pending", () => {
    expect(selectFocus(inputs({ continueItems: ready([]), summary: PENDING }))).toEqual({ kind: "pending" });
  });
  it("7. a truly empty library → add-video", () => {
    expect(selectFocus(inputs({ continueItems: ready([]), vocab: ready(stats({ total: 0, learning: 0 })), summary: ready(summary({ libraryVideos: 0, vocabularyCount: 0 })) }))).toEqual({
      kind: "add-video",
    });
  });
  it("8. otherwise hidden: nothing-actionable only when every source reached resolved", () => {
    expect(selectFocus(inputs({ continueItems: ready([item({}, { correct: 8, practiced: 8 })]) }))).toEqual({ kind: "hidden", reason: "nothing-actionable" });
  });
  it("a top item with needsReview 0 falls through to vocabulary", () => {
    expect(selectFocus(inputs({ continueItems: ready([item({}, { correct: 8, practiced: 8 })]), vocab: ready(stats({ due: 1, reviewable: 1 })) }))).toMatchObject({
      kind: "vocabulary",
    });
  });
});

describe("errors are never 'nothing to do'", () => {
  it("Continue error skips sentences but vocabulary still qualifies on its own data", () => {
    expect(selectFocus(inputs({ continueItems: ERROR, vocab: ready(stats({ due: 2, reviewable: 2 })) }))).toMatchObject({ kind: "vocabulary", due: 2 });
  });
  it("Continue error + no vocabulary action + non-empty library → unavailable", () => {
    expect(selectFocus(inputs({ continueItems: ERROR }))).toEqual({ kind: "hidden", reason: "unavailable" });
  });
  it("Continue error + provably empty library → add-video (no library means no sentence candidate)", () => {
    expect(selectFocus(inputs({ continueItems: ERROR, summary: ready(summary({ libraryVideos: 0, vocabularyCount: 0 })) }))).toEqual({ kind: "add-video" });
  });
  it("summary error after sentences/vocabulary don't qualify → unavailable, never add-video", () => {
    expect(selectFocus(inputs({ continueItems: ready([]), summary: ERROR }))).toEqual({ kind: "hidden", reason: "unavailable" });
  });
  it("vocabulary error + non-empty library → unavailable", () => {
    expect(selectFocus(inputs({ continueItems: ready([]), vocab: ERROR }))).toEqual({ kind: "hidden", reason: "unavailable" });
  });
  it("vocabulary error + empty library: add-video only when the summary itself shows no saved words", () => {
    expect(selectFocus(inputs({ continueItems: ready([]), vocab: ERROR, summary: ready(summary({ libraryVideos: 0, vocabularyCount: 0 })) }))).toEqual({ kind: "add-video" });
    expect(selectFocus(inputs({ continueItems: ready([]), vocab: ERROR, summary: ready(summary({ libraryVideos: 0, vocabularyCount: 5 })) }))).toEqual({
      kind: "hidden",
      reason: "unavailable",
    });
  });
  it("an existing user never gets add-video, whatever fails", () => {
    for (const continueItems of [ERROR, ready([])] as const) {
      for (const vocab of [ERROR, ready(stats())] as const) {
        expect(selectFocus({ continueItems, vocab, summary: ready(summary({ libraryVideos: 4 })) }).kind).not.toBe("add-video");
      }
    }
  });
});

describe("toFocusSource: cached data stays ready", () => {
  it("data present → ready, even during a refetch or after a failed refetch", () => {
    expect(toFocusSource({ data: 1, isError: true })).toEqual({ status: "ready", data: 1 });
  });
  it("no data: error → error; otherwise pending", () => {
    expect(toFocusSource({ data: undefined, isError: true })).toEqual({ status: "error" });
    expect(toFocusSource({ data: undefined, isError: false })).toEqual({ status: "pending" });
  });
});
