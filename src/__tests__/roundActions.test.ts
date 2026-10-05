/**
 * Learning Reports P2 (plan §5.3–§5.4): one action table for the completion
 * view, the full report and History. Same-round actions never create a round;
 * the new-round action always says so.
 */
import {
  continueShadowingHref,
  parseContinuationRequest,
  resolveContinuationStart,
  roundActions,
  shadowingContinuation,
} from "@/lib/practice/roundActions";
import type { ReportSentence, RoundReport } from "@/lib/types/learning";

const taken = (i: number, scored: boolean): ReportSentence => ({
  segmentIndex: i,
  text: `S${i}`,
  eligible: true,
  category: "shadowing_only",
  dictation: null,
  shadowing: { takes: 1, validTakes: 1, latestAzure: scored ? { pronunciationScore: 80, evaluatedAt: "x", attemptId: `z${i}` } : null, latestWordMatch: null },
});

function report(over: { status?: RoundReport["round"]["status"]; recorded?: number; required?: number | null; sentences?: ReportSentence[]; transcriptId?: string | null } = {}): RoundReport {
  const required = over.required === undefined ? 59 : over.required;
  return {
    round: {
      roundId: "r1", videoId: "vid", title: "T", transcriptId: over.transcriptId === undefined ? "tr" : over.transcriptId,
      status: over.status ?? "completed", provenance: "current", roundNumber: 1, requiredSentenceCount: required,
      startedAt: "x", updatedAt: "x", completedAt: "x", completedAtApproximate: false, currentSegmentIndex: 0,
    },
    historyComplete: true,
    progress: {
      requiredSentenceCount: required,
      coveredSentences: { dictation: 59, shadowing: over.recorded ?? 6, overall: 59 },
      coverage: { dictation: 1, shadowing: 0.1, overall: 1 },
      attemptCount: 0,
      sentenceAccuracy: { correct: 59, practiced: 59, percent: 100 },
    },
    dictation: {} as RoundReport["dictation"],
    shadowing: {} as RoundReport["shadowing"],
    activity: {} as RoundReport["activity"],
    sentences: over.sentences ?? [],
  };
}
const kinds = (r: RoundReport, newer?: { roundId: string; roundNumber: number }) => roundActions(r, { newerActiveRound: newer }).map((a) => a.kind);

describe("the unified action table", () => {
  it("Dictation 59/59, Shadowing 6/59: continue Shadowing in THIS round first; a new round is a separate, labelled action", () => {
    const actions = roundActions(report());
    expect(actions.map((a) => a.kind)).toEqual(["continue_shadowing", "view_report", "practice_again_new_round"]);
    expect(actions[0]).toMatchObject({ primary: true, start: "unrecorded", label: "Continue Shadowing in this round (53 sentences left)" });
    expect(actions[2].label).toBe("Practice again — new round");
  });

  it("all recorded, some unscored: continue pronunciation scoring, explaining that recordings aren't kept", () => {
    const actions = roundActions(report({ recorded: 59, sentences: [taken(0, true), taken(1, false), taken(2, false)] }));
    expect(actions[0]).toMatchObject({ kind: "continue_scoring", start: "unscored", label: "Continue pronunciation scoring in this round (2 left)" });
    expect(actions[0].note).toMatch(/recordings aren't kept/);
  });

  it("all scored: the summary first; practising again in this round is explicit and distinct from a new round", () => {
    expect(kinds(report({ recorded: 59, sentences: [taken(0, true)] }))).toEqual([
      "view_shadowing_summary",
      "practise_shadowing_same_round",
      "practice_again_new_round",
    ]);
  });

  it("a newer active round, an abandoned round or a missing script pin never offer continuation", () => {
    expect(kinds(report(), { roundId: "r2", roundNumber: 2 })).toEqual(["go_to_current_round", "view_report"]);
    expect(roundActions(report(), { newerActiveRound: { roundId: "r2", roundNumber: 2 } })[0].label).toBe("Go to current round (Round 2)");
    expect(kinds(report({ status: "abandoned" }))).toEqual(["view_report", "practice_again_new_round"]);
    expect(kinds(report({ transcriptId: null }))).toEqual(["view_report", "practice_again_new_round"]);
  });

  it("the report link uses the app-wide generic label 'Review report'", () => {
    for (const actions of [roundActions(report(), { newerActiveRound: { roundId: "r2", roundNumber: 2 } }), roundActions(report({ status: "abandoned" }))]) {
      expect(actions.find((a) => a.kind === "view_report")?.label).toBe("Review report");
    }
  });

  it("an active round just continues practice", () => {
    expect(kinds(report({ status: "active" }))).toEqual(["continue_practice", "practice_again_new_round"]);
  });

  it("unknown round size gives no Shadowing claim", () => {
    expect(shadowingContinuation(report({ required: null }))).toBeNull();
  });
});

describe("continuation start (re-derived, not a saved playhead)", () => {
  const segs = [{ text: "One." }, { text: "♪" }, { text: "Two." }, { text: "Three." }];
  it("unrecorded = first ELIGIBLE sentence without a valid take", () => {
    expect(resolveContinuationStart("unrecorded", segs, [taken(0, true)])).toBe(2); // index 1 is a blank cue
  });
  it("unscored = first recorded sentence without a saved Azure score", () => {
    expect(resolveContinuationStart("unscored", segs, [taken(0, true), taken(2, false)])).toBe(2);
  });
  it("falls back to the first eligible sentence", () => {
    expect(resolveContinuationStart("unscored", segs, [taken(0, true)])).toBe(0);
    expect(resolveContinuationStart("first", [{ text: "♪" }, { text: "Hi." }], [])).toBe(1);
  });
});

describe("continuation links", () => {
  const ROUND = "11111111-1111-4111-8111-111111111111";
  it("round-trip through the URL; malformed requests are ignored", () => {
    const href = continueShadowingHref("vid", ROUND, "unscored");
    expect(parseContinuationRequest(href.slice(href.indexOf("?")))).toEqual({ roundId: ROUND, mode: "shadowing", start: "unscored" });
    expect(parseContinuationRequest(`?round=not-a-uuid&mode=shadowing&start=first`)).toBeNull();
    expect(parseContinuationRequest(`?round=${ROUND}&mode=dictation&start=first`)).toBeNull();
    expect(parseContinuationRequest(`?round=${ROUND}&mode=shadowing&start=anywhere`)).toBeNull();
  });
});
