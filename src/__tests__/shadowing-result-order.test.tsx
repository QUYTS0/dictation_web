/**
 * R1 (.claude/shadowing-summary-audit.md): results that arrive out of order
 * must end up selecting the same representative as a reload — the latest
 * RECORDING (server created_at, then id) among saved successful results —
 * on every promotion path (direct save, polling, recovery). Also: obsolete
 * reads never overwrite newer state, and a confirmed save (incl. recovery)
 * refreshes the round report / Dashboard / History caches (D7), while a
 * superseded or conflicting one does not. Hook tests, HTTP mocked, no Azure.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useShadowingEvaluations } from "@/app/dictation/[videoId]/useShadowingEvaluations";
import { azureResultFrom } from "@/app/dictation/[videoId]/shadowingServerMerge";
import { roundReportKeys } from "@/lib/queries/roundReport";
import { shadowingRoundResultsKeys } from "@/lib/queries/shadowingRoundResults";
import { dashboardKeys } from "@/lib/queries/dashboard";
import type { ShadowingAttemptDto, ShadowingRoundResults } from "@/lib/practice/shadowingTypes";
import { mergeServerResults } from "@/app/dictation/[videoId]/shadowingServerMerge";
import { EvaluationTab } from "@/app/dictation/[videoId]/components/EvaluationTab";
import { buildShadowingRoundSummary, compareResultOrder } from "@/lib/practice/shadowingSummary";
import { fromRoundResults } from "@/lib/practice/shadowingSummaryInput";
import type { SentenceEvaluation, ShadowingPersistenceView, TrueEvaluationWord } from "@/app/dictation/[videoId]/types";
import type { RecordedClip } from "@/hooks/useAudioRecorder";

const TEXT = ["One two three.", "Four five six."];
const OLD_AT = "2026-09-01T10:00:00.000Z";
const NEW_AT = "2026-09-01T10:05:00.000Z";

type DetailWords = NonNullable<ShadowingAttemptDto["azure"]["detail"]>["words"];
function dto(attemptId: string, createdAt: string, pron: number | null, words: unknown[] = []): ShadowingAttemptDto {
  return {
    attemptId, clientAttemptId: `c-${attemptId}`, roundId: "round-1", youtubeVideoId: "vid", transcriptId: "tr-1", segmentIndex: 0, createdAt,
    recordingDurationSec: 2, isPracticeValid: true, validityBasis: "client_reported", studySessionId: null,
    azure: {
      status: pron === null ? "not_evaluated" : "completed", seq: 1, requestedAt: null, evaluatedAt: pron === null ? null : createdAt,
      pronunciationScore: pron, accuracyScore: pron, fluencyScore: pron, completenessScore: pron, prosodyScore: null, errorReason: null,
      engineVersion: null, detail: pron === null ? null : { recognizedText: "one two three", words: words as DetailWords },
    },
    wordMatch: { status: null, seq: 0, accuracy: null, completeness: null, evaluatedAt: null, detail: null },
  };
}
// A's word feedback flags "one", B's flags "two" — so a briefly wrong
// representative would show up in the word priorities too.
const A_WORDS = [{ word: "One", accuracyScore: 40, errorType: "Mispronunciation" }, { word: "two", accuracyScore: 95, errorType: "None" }, { word: "three", accuracyScore: 95, errorType: "None" }];
const B_WORDS = [{ word: "One", accuracyScore: 95, errorType: "None" }, { word: "two", accuracyScore: 45, errorType: "Mispronunciation" }, { word: "three", accuracyScore: 95, errorType: "None" }];
const A = dto("A", OLD_AT, 60, A_WORDS); // the OLDER recording
const B = dto("B", NEW_AT, 90, B_WORDS); // the NEWER recording
const history = (ds: ShadowingAttemptDto[]) =>
  ds.map((d) => ({ attemptId: d.attemptId, createdAt: d.createdAt, evaluatedAt: d.azure.evaluatedAt, pronunciationScore: d.azure.pronunciationScore,
    accuracyScore: d.azure.accuracyScore, fluencyScore: null, completenessScore: null, prosodyScore: null, words: [] }));
/** The server's view: representative = latest RECORDING (created_at, then id), history in that order. */
function round(successes: ShadowingAttemptDto[], roundId = "round-1", transcriptId = "tr-1"): ShadowingRoundResults {
  const ordered = [...successes].sort((x, y) => (x.createdAt === y.createdAt ? (x.attemptId < y.attemptId ? -1 : 1) : x.createdAt < y.createdAt ? -1 : 1));
  const latest = ordered[ordered.length - 1];
  return {
    roundId, youtubeVideoId: "vid", transcriptId, roundStatus: "active", evaluationTimeoutSec: 120,
    segments: latest ? [{ segmentIndex: 0, attemptCount: ordered.length, latestAttempt: latest, latestSuccessfulAzureAttempt: latest, latestWordMatchAttempt: null, azureHistory: history(ordered) }] : [],
  };
}
/** The server after both saves: B (newer recording) is the representative. */
const BOTH_SAVED = round([A, B]);

const fetchMock = jest.fn();
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const respond = (body: unknown) => fetchMock.mockResolvedValue(json(body));
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve: (body: unknown) => resolve(json(body)) };
}

type Scope = { roundId: string; userId?: string; transcriptId?: string };
type HookValue = ReturnType<typeof useShadowingEvaluations>;
function mount(roundId = "round-1", onRender?: (v: HookValue) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = jest.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(
    (p: Scope) => {
      const v = useShadowingEvaluations({
        videoId: "vid", transcriptId: p.transcriptId ?? "tr-1", userId: p.userId ?? "user-1", roundId: p.roundId, eligibleSentences: 2, recordedSentences: 1,
        referenceTextFor: (i) => TEXT[i] ?? "",
      });
      onRender?.(v);
      return v;
    },
    { wrapper, initialProps: { roundId } as Scope }
  );
  return { ...hook, qc, invalidate };
}
const representative = (r: { current: ReturnType<typeof useShadowingEvaluations> }) => r.current.evaluations[0]?.lastSuccessfulTrueEvaluation?.attemptId;
const meta = { referenceText: TEXT[0], wordCount: 3, audioDuration: 2 };

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  sessionStorage.clear();
});

describe("R1 — out-of-order results agree with the server's selection", () => {
  it("direct save: the newer recording's result arrives first, the older one's later → never placed by arrival; the server places both", async () => {
    respond(round([]));
    const { result } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const origin = result.current.scopeKey;
    respond(BOTH_SAVED); // what the server holds once both results are saved

    act(() => result.current.startTrueEvaluation(origin, 0, meta));
    act(() => result.current.completeTrueEvaluation(origin, 0, { pronunciationScore: 90, attemptId: "B", seq: 1, persistence: "saved" }));
    act(() => result.current.completeTrueEvaluation(origin, 0, { pronunciationScore: 60, attemptId: "A", seq: 1, persistence: "saved" }));
    // Live results carry no recording time: neither is placed by arrival
    // order (the first implementation showed A here until the re-read).
    expect(representative(result)).toBeUndefined();
    expect(result.current.evaluations[0].selectionPending).toEqual(["B", "A"]);
    expect(result.current.evaluations[0].trueEvaluation).toMatchObject({ attemptId: "A", persistence: "saved" }); // A's own card
    // The server read places them: the NEWER recording wins, as after a reload.
    await waitFor(() => expect(representative(result)).toBe("B"));
    expect(result.current.summary.metrics.pronunciation?.value).toBe(90);
    expect(result.current.summary.coverage.scoredSentences).toBe(1); // counted once
    expect(result.current.summaryRefresh).toBeNull();
  });

  it("polling (results read back from the server carry the recording time): an older result never takes over, even briefly", async () => {
    respond(round([]));
    const { result } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const origin = result.current.scopeKey;
    respond(BOTH_SAVED);
    act(() => result.current.completeTrueEvaluation(origin, 0, { ...azureResultFrom(B), persistence: "saved" }));
    act(() => result.current.completeTrueEvaluation(origin, 0, { ...azureResultFrom(A), persistence: "saved" }));
    expect(representative(result)).toBe("B");
    expect(result.current.evaluations[0].attempts?.map((a) => a.attemptId)).toEqual(["A", "B"]); // chronological history
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(representative(result)).toBe("B");
  });

  it("recovery of the older take's score after the newer one was saved → still the newer, and the views are refreshed", async () => {
    respond(round([]));
    const { result, invalidate } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const origin = result.current.scopeKey;
    act(() => result.current.completeTrueEvaluation(origin, 0, { pronunciationScore: 60, attemptId: "A", seq: 1, persistence: "unsaved" }));
    respond(round([B]));
    act(() => result.current.completeTrueEvaluation(origin, 0, { pronunciationScore: 90, attemptId: "B", seq: 1, persistence: "saved" }));
    await waitFor(() => expect(result.current.evaluations[0]?.lastSuccessfulTrueEvaluation?.restored).toBe(true));
    invalidate.mockClear();
    respond(BOTH_SAVED);
    const callsBefore = fetchMock.mock.calls.length;
    act(() => result.current.setTrueEvaluationPersistence(origin, 0, "A", "saved"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(callsBefore + 1)); // re-read once
    await waitFor(() => expect(result.current.evaluations[0].attempts?.map((a) => a.attemptId)).toEqual(["A", "B"])); // the server's history
    expect(representative(result)).toBe("B");
    // D7: the round report, its saved results, Dashboard and History are marked stale.
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify(roundReportKeys.report("user-1", "round-1")),
        JSON.stringify(shadowingRoundResultsKeys.round("user-1", "round-1")),
        JSON.stringify(dashboardKeys.summary("user-1")),
        JSON.stringify(["history-sessions", "user-1"]),
      ])
    );
  });
});

describe("D7 — only a CONFIRMED save refreshes the views", () => {
  it("superseded / conflicting / unsaved results trigger no refresh and no re-read", async () => {
    respond(round([]));
    const { result, invalidate } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const origin = result.current.scopeKey;
    act(() => result.current.completeTrueEvaluation(origin, 0, { pronunciationScore: 70, attemptId: "X", seq: 1, persistence: "unsaved" }));
    act(() => result.current.setTrueEvaluationPersistence(origin, 0, "X", "superseded"));
    act(() => result.current.completeTrueEvaluation(origin, 0, { pronunciationScore: 70, attemptId: "Y", seq: 1, persistence: "conflict" }));
    await act(async () => {});
    expect(invalidate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("obsolete responses are ignored", () => {
  it("a read that started BEFORE a save cannot overwrite the reconciled state after it", async () => {
    const first = deferred();
    fetchMock.mockReturnValueOnce(first.promise);
    const { result } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const origin = result.current.scopeKey;
    fetchMock.mockResolvedValueOnce(json(round([B])));
    act(() => result.current.completeTrueEvaluation(origin, 0, { pronunciationScore: 90, attemptId: "B", seq: 1, persistence: "saved" }));
    await waitFor(() => expect(result.current.evaluations[0]?.lastSuccessfulTrueEvaluation?.restored).toBe(true));
    await act(async () => first.resolve(round([]))); // the stale read lands last
    expect(representative(result)).toBe("B");
    expect(result.current.summary.coverage.scoredSentences).toBe(1);
  });

  it("a reconcile answer for the previous round never lands on the next round", async () => {
    respond(round([]));
    const { result, rerender } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const origin = result.current.scopeKey;
    const late = deferred();
    fetchMock.mockReturnValueOnce(late.promise);
    act(() => result.current.completeTrueEvaluation(origin, 0, { pronunciationScore: 90, attemptId: "B", seq: 1, persistence: "saved" }));
    respond(round([], "round-2"));
    rerender({ roundId: "round-2" }); // restart into round 2
    await act(async () => late.resolve(BOTH_SAVED));
    expect(result.current.evaluations).toEqual({});
    expect(result.current.summary.coverage.scoredSentences).toBe(0);
  });
});

// ------------------------------------------------------------------------
// R1 follow-up: a take's own result vs the round's confirmed selection.
// A live result (direct evaluation or recovery) carries no recording time;
// it may show on its take's card, but the representative score, history and
// every summary keep the last CONFIRMED selection until a server read that
// started after the save places it.
// ------------------------------------------------------------------------

const COUNTS = { eligibleSentences: 2, recordedSentences: 1 };
const reportSummaryOf = (server: ShadowingRoundResults) => buildShadowingRoundSummary(fromRoundResults(server, (i) => TEXT[i] ?? "", COUNTS));
/** A's live result, exactly as the evaluate response delivers it (no recording time). */
const liveA = {
  pronunciationScore: 60, accuracyScore: 60, fluencyScore: 60, completenessScore: 60,
  words: A_WORDS as unknown as TrueEvaluationWord[], attemptId: "A", seq: 1, persistence: "saved" as const, clipId: "blob:A",
};
const STORAGE_KEY = "dictation.shadowing.v2.user-1.vid.tr-1.round-1";
const storedEntry = () => (JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Record<number, SentenceEvaluation>)[0];

/** B (the NEWER recording) saved and confirmed by the server; returns the hook. */
async function withBConfirmed(onRender?: (v: HookValue) => void) {
  respond(round([]));
  const m = mount("round-1", onRender);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const origin = m.result.current.scopeKey;
  respond(round([B]));
  act(() => m.result.current.completeTrueEvaluation(origin, 0, { ...azureResultFrom(B), persistence: "saved" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  // Merged from the server read (which brings the recording's duration — the summary's weight).
  await waitFor(() => expect(m.result.current.summary.metrics.pronunciation?.value).toBe(90));
  return { ...m, origin };
}

describe("R1 follow-up — provisional take results never replace the confirmed selection", () => {
  it("exact scenario: B confirmed, A (older) arrives later without ordering data, the server read is delayed → the summary stays on B throughout", async () => {
    const seen: { rep?: string; pron?: number; top?: string }[] = [];
    const { result, qc, origin } = await withBConfirmed((v) =>
      seen.push({ rep: v.evaluations[0]?.lastSuccessfulTrueEvaluation?.attemptId, pron: v.summary.metrics.pronunciation?.value, top: v.summary.priorities[0]?.key })
    );
    const confirmed = result.current.summary;
    expect(confirmed.priorities[0]?.key).toBe("two"); // B's feedback
    const late = deferred();
    fetchMock.mockReturnValueOnce(late.promise);
    seen.length = 0;

    act(() => result.current.completeTrueEvaluation(origin, 0, liveA));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3)); // the reconcile read, held back

    // During the delay: the round summary, representative and history are B's.
    expect(representative(result)).toBe("B");
    expect(result.current.summary).toEqual(confirmed);
    expect(result.current.evaluations[0].attempts?.map((a) => a.attemptId)).toEqual(["B"]);
    // A's own card shows A's saved score, flagged as not yet placed.
    expect(result.current.evaluations[0].trueEvaluation).toMatchObject({ attemptId: "A", pronunciationScore: 60, persistence: "saved" });
    expect(result.current.evaluations[0].selectionPending).toEqual(["A"]);
    expect(result.current.summaryRefresh).toBe("pending");
    // Never written as authoritative: the shared report cache holds only
    // server answers, and the sessionStorage mirror keeps B as representative.
    expect(qc.getQueryData(shadowingRoundResultsKeys.round("user-1", "round-1"))).toEqual(round([B]));
    expect(storedEntry().lastSuccessfulTrueEvaluation?.attemptId).toBe("B");
    expect(storedEntry().attempts?.map((a) => a.attemptId)).toEqual(["B"]);

    await act(async () => late.resolve(BOTH_SAVED));
    expect(representative(result)).toBe("B");
    expect(result.current.evaluations[0].attempts?.map((a) => a.attemptId)).toEqual(["A", "B"]);
    expect(result.current.summaryRefresh).toBeNull();
    expect(result.current.evaluations[0].selectionPending).toBeUndefined();
    // After reconciliation the live summary equals the report built from the server.
    const report = reportSummaryOf(BOTH_SAVED);
    expect(result.current.summary.metrics).toEqual(report.metrics);
    expect(result.current.summary.priorities).toEqual(report.priorities);
    expect(result.current.summary.coverage).toEqual(report.coverage);
    expect(result.current.summary.sentenceImprovements).toEqual(report.sentenceImprovements);
    // Not a single render switched to A's score or A's word priorities.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.rep === "B" && x.pron === 90 && x.top === "two")).toBe(true);
  });

  it("the reconciliation read fails → confirmed data kept, a manual refresh is offered, no refetch loop, no evaluate call", async () => {
    const { result, origin } = await withBConfirmed();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    act(() => result.current.completeTrueEvaluation(origin, 0, liveA));
    await waitFor(() => expect(result.current.summaryRefresh).toBe("failed"));
    expect(representative(result)).toBe("B");
    expect(result.current.summary.metrics.pronunciation?.value).toBe(90);
    expect(result.current.evaluations[0].trueEvaluation?.persistence).toBe("saved"); // still saved, not "unsaved"
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(fetchMock).toHaveBeenCalledTimes(3); // load, B's reconcile, A's failed reconcile — nothing more
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/api/practice/attempts"))).toBe(true);

    respond(BOTH_SAVED);
    act(() => result.current.reloadFromServer());
    await waitFor(() => expect(result.current.summaryRefresh).toBeNull());
    expect(representative(result)).toBe("B");
    expect(result.current.evaluations[0].attempts?.map((a) => a.attemptId)).toEqual(["A", "B"]);
  });

  it("a restored page never treats a pending result as the selection (load fails → still B, refresh offered)", async () => {
    const { result, origin, unmount } = await withBConfirmed();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    act(() => result.current.completeTrueEvaluation(origin, 0, liveA));
    await waitFor(() => expect(result.current.summaryRefresh).toBe("failed"));
    unmount();

    fetchMock.mockRejectedValueOnce(new Error("offline")); // the reloaded page cannot reach the server either
    const again = mount();
    await waitFor(() => expect(again.result.current.serverLoadError).not.toBeNull());
    expect(again.result.current.evaluations[0].lastSuccessfulTrueEvaluation?.attemptId).toBe("B");
    expect(again.result.current.evaluations[0].attempts?.map((a) => a.attemptId)).toEqual(["B"]);
    expect(again.result.current.summary.metrics.pronunciation?.value).toBe(90);
    expect(again.result.current.summaryRefresh).toBe("failed");
  });

  it("an older read that returns after a newer save cannot place (or un-place) anything", async () => {
    const { result, origin } = await withBConfirmed();
    const r1 = deferred();
    fetchMock.mockReturnValueOnce(r1.promise);
    act(() => result.current.completeTrueEvaluation(origin, 0, { ...liveA, attemptId: "X", clipId: "blob:X", persistence: "unsaved" }));
    act(() => result.current.reloadFromServer()); // a read that starts BEFORE A is saved
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const r2 = deferred();
    fetchMock.mockReturnValueOnce(r2.promise);
    act(() => result.current.completeTrueEvaluation(origin, 0, liveA));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await act(async () => r2.resolve(BOTH_SAVED));
    await act(async () => r1.resolve(round([B]))); // the older answer lands last
    expect(result.current.evaluations[0].attempts?.map((a) => a.attemptId)).toEqual(["A", "B"]);
    expect(representative(result)).toBe("B");
    expect(result.current.summaryRefresh).toBeNull();
  });

  it("the merge itself only clears results this read can know about", () => {
    const local: Record<number, SentenceEvaluation> = {
      0: { segmentIndex: 0, referenceText: TEXT[0], wordCount: 3, audioDuration: 2, selectionPending: ["A"], trueEvaluation: { status: "completed", ...liveA } },
    };
    const early = mergeServerResults(local, round([B]), (i) => TEXT[i], { preserveLive: true, placedByThisRead: () => false });
    expect(early[0].selectionPending).toEqual(["A"]);
    expect(early[0].lastSuccessfulTrueEvaluation?.attemptId).toBe("B");
    const after = mergeServerResults(local, BOTH_SAVED, (i) => TEXT[i], { preserveLive: true, placedByThisRead: () => true });
    expect(after[0].selectionPending).toBeUndefined();
  });

  it.each([
    ["round", { roundId: "round-2" }, round([], "round-2")],
    ["account", { roundId: "round-1", userId: "user-2" }, round([])],
    ["script revision", { roundId: "round-1", transcriptId: "tr-2" }, round([], "round-1", "tr-2")],
  ])("leaving the %s while the read is delayed: nothing lands on the new scope", async (_label, next, nextServer) => {
    const { result, origin, rerender, qc } = await withBConfirmed();
    const late = deferred();
    fetchMock.mockReturnValueOnce(late.promise);
    act(() => result.current.completeTrueEvaluation(origin, 0, liveA));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    respond(nextServer);
    rerender(next);
    await act(async () => late.resolve(BOTH_SAVED));
    expect(result.current.evaluations).toEqual({});
    expect(result.current.summaryRefresh).toBeNull();
    expect(result.current.summary.coverage.scoredSentences).toBe(0);
    // The cancelled read wrote nothing (the new scope's own read may fill its own key).
    expect(qc.getQueryData(shadowingRoundResultsKeys.round("user-1", "round-1"))).not.toEqual(BOTH_SAVED);
  });

  it("equal recording times: the larger attempt id wins (the server's `created_at, id` order), whichever arrives first", async () => {
    const SAME = "2026-09-01T10:00:00.000Z";
    const lo = dto("3f2a0000-0000-4000-8000-000000000001", SAME, 70);
    const hi = dto("a1000000-0000-4000-8000-000000000002", SAME, 80);
    expect(compareResultOrder({ recordingCreatedAt: SAME, evaluatedAt: null, attemptId: lo.attemptId }, { recordingCreatedAt: SAME, evaluatedAt: null, attemptId: hi.attemptId })).toBeLessThan(0);
    for (const order of [[hi, lo], [lo, hi]]) {
      sessionStorage.clear();
      fetchMock.mockReset();
      respond(round([]));
      const { result, unmount } = mount();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const origin = result.current.scopeKey;
      respond(round([lo, hi]));
      act(() => result.current.completeTrueEvaluation(origin, 0, { ...azureResultFrom(order[0]), persistence: "saved" }));
      act(() => result.current.completeTrueEvaluation(origin, 0, { ...azureResultFrom(order[1]), persistence: "saved" }));
      expect(representative(result)).toBe(hi.attemptId); // immediately — both carry their recording time
      await waitFor(() => expect(result.current.summary.metrics.pronunciation?.value).toBe(80)); // after the server read
      expect(representative(result)).toBe(hi.attemptId);
      unmount();
    }
  });

  it("first saved evaluation: saved on its card, \"updating\" in the summary, then placed", async () => {
    respond(round([]));
    const { result } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const origin = result.current.scopeKey;
    const late = deferred();
    fetchMock.mockReturnValueOnce(late.promise);
    act(() => result.current.completeTrueEvaluation(origin, 0, liveA));
    expect(representative(result)).toBeUndefined();
    expect(result.current.summary.coverage.scoredSentences).toBe(0); // not counted before the server places it
    expect(result.current.evaluations[0].trueEvaluation?.persistence).toBe("saved");
    expect(result.current.summaryRefresh).toBe("pending");
    await act(async () => late.resolve(round([A])));
    expect(representative(result)).toBe("A");
    expect(result.current.summary.coverage.scoredSentences).toBe(1);
    expect(result.current.summaryRefresh).toBeNull();
  });
});

describe("R1 follow-up — what the take card says", () => {
  const quota = { engineConfigured: true, usedSec: 0, limitSec: 18_000, usedCount: 0, limitReached: false };
  const clip = { blob: new Blob(["x"]), url: "blob:A", mimeType: "audio/webm", durationSec: 2 } as RecordedClip;
  const persistence = (over: Partial<ShadowingPersistenceView>): ShadowingPersistenceView => ({
    signedIn: true, recordingSave: { status: "saved", isPracticeValid: true }, onRetrySave: jest.fn(), canRetryScoreSave: false,
    onRetryScoreSave: jest.fn(), roundCompleted: false, loadError: null, ...over,
  });
  const entry: SentenceEvaluation = {
    segmentIndex: 0, referenceText: TEXT[0], wordCount: 3, audioDuration: 2, selectionPending: ["A"],
    trueEvaluation: { status: "completed", ...liveA }, lastSuccessfulTrueEvaluation: { ...azureResultFrom(B) },
  };
  const renderCard = (view: ShadowingPersistenceView) =>
    render(
      <EvaluationTab
        entry={entry} recorderStatus="idle" recordingClip={clip} autoWordMatchEnabled onRetryWordMatch={jest.fn()} quota={quota}
        evaluationSummary={buildShadowingRoundSummary({ eligibleSentences: 2, recordedSentences: 1, sentences: [] })} onJumpToSegment={jest.fn()}
        persistence={view}
      />
    );

  it("pending: the take's saved score with \"updating the round summary\", never \"not saved\"", () => {
    renderCard(persistence({ summaryRefresh: "pending" }));
    expect(screen.getByTestId("summary-refresh-pending")).toHaveTextContent("Saved · updating the round summary…");
    expect(screen.queryByText(/isn.t saved yet/)).toBeNull();
  });

  it("failed: says the score is saved and offers a refresh that only re-reads", () => {
    const onRetrySummaryRefresh = jest.fn();
    renderCard(persistence({ summaryRefresh: "failed", onRetrySummaryRefresh }));
    expect(screen.getByTestId("summary-refresh-failed")).toHaveTextContent("Your score is saved, but the round summary couldn't refresh");
    expect(screen.queryByTestId("summary-refresh-pending")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Refresh summary/ }));
    expect(onRetrySummaryRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
