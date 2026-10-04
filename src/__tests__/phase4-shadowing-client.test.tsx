import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mergeServerResults, entryFromServer } from "@/app/dictation/[videoId]/shadowingServerMerge";
import {
  acceptsOrigin,
  clearShadowingCache,
  loadShadowingEvaluations,
  saveShadowingEvaluations,
  scopeKey,
} from "@/app/dictation/[videoId]/shadowingEvaluationPersistence";
import { useShadowingEvaluations } from "@/app/dictation/[videoId]/useShadowingEvaluations";
import { useShadowingRecordings } from "@/app/dictation/[videoId]/useShadowingRecordings";
import type { ShadowingAttemptDto, ShadowingRoundResults } from "@/lib/practice/shadowingTypes";
import type { SentenceEvaluation } from "@/app/dictation/[videoId]/types";


/** useShadowingEvaluations shares its server reads with the report cache. */
function queryWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

// ---------------------------------------------------------------- fixtures

function dto(id: string, seg: number, over: Partial<{ azure: Partial<ShadowingAttemptDto["azure"]>; wordMatch: Partial<ShadowingAttemptDto["wordMatch"]>; createdAt: string }> = {}): ShadowingAttemptDto {
  return {
    attemptId: id,
    clientAttemptId: `c-${id}`,
    roundId: "round-1",
    youtubeVideoId: "vid",
    transcriptId: "tr-1",
    segmentIndex: seg,
    createdAt: over.createdAt ?? "2026-09-01T10:00:00Z",
    recordingDurationSec: 2,
    isPracticeValid: true,
    validityBasis: "client_reported",
    studySessionId: null,
    azure: {
      status: "not_evaluated",
      seq: 0,
      requestedAt: null,
      evaluatedAt: null,
      pronunciationScore: null,
      accuracyScore: null,
      fluencyScore: null,
      completenessScore: null,
      prosodyScore: null,
      errorReason: null,
      engineVersion: null,
      detail: null,
      ...over.azure,
    },
    wordMatch: { status: null, seq: 0, accuracy: null, completeness: null, evaluatedAt: null, detail: null, ...over.wordMatch },
  };
}

const evaluatedOld = dto("att-old", 0, {
  azure: { status: "completed", seq: 1, pronunciationScore: 64, accuracyScore: 70, prosodyScore: null, evaluatedAt: "2026-09-01T10:01:00Z", detail: { recognizedText: "hello", words: [{ word: "hello", accuracyScore: 70, errorType: "None" }] } },
  wordMatch: { status: "completed", seq: 1, accuracy: 50, completeness: 100, detail: { recognizedText: "hello", problemWords: [] } },
});
const latestUnevaluated = dto("att-new", 0, { createdAt: "2026-09-01T11:00:00Z" });

const SERVER: ShadowingRoundResults = {
  roundId: "round-1",
  youtubeVideoId: "vid",
  transcriptId: "tr-1",
  roundStatus: "active",
  evaluationTimeoutSec: 120,
  segments: [
    {
      segmentIndex: 0,
      attemptCount: 2,
      latestAttempt: latestUnevaluated,
      latestSuccessfulAzureAttempt: evaluatedOld,
      latestWordMatchAttempt: evaluatedOld,
      azureHistory: [{ attemptId: "att-old", createdAt: "2026-09-01T10:00:00Z", evaluatedAt: "2026-09-01T10:01:00Z", pronunciationScore: 64, accuracyScore: 70, fluencyScore: null, completenessScore: null, prosodyScore: null, words: [] }],
    },
  ],
};
const TEXT = (i: number) => ["Hello there.", "How are you?"][i] ?? "";

// ------------------------------------------------------------ merge rules

describe("server reconciliation", () => {
  it("builds three independent, chronological pointers; unavailable metrics stay undefined (not 0)", () => {
    const e = entryFromServer(SERVER.segments[0], "Hello there.");
    expect(e.lastSuccessfulTrueEvaluation).toMatchObject({ status: "completed", attemptId: "att-old", pronunciationScore: 64, persistence: "saved", restored: true });
    expect(e.lastSuccessfulTrueEvaluation?.prosodyScore).toBeUndefined();
    expect(e.lastSuccessfulTrueEvaluation?.fluencyScore).toBeUndefined();
    expect(e.wordMatch).toMatchObject({ status: "completed", accuracy: 50, attemptId: "att-old", persisted: true });
    expect(e.latestRecording).toMatchObject({ attemptId: "att-new", azureStatus: "not_evaluated" });
    expect(e.attempts).toHaveLength(1);
    expect(e.wordCount).toBe(2);
  });

  it("server truth wins; stale/unscoped local entries are never promoted", () => {
    const local: Record<number, SentenceEvaluation> = {
      // pre-Phase-4 entry: no attemptId → dropped
      1: { segmentIndex: 1, referenceText: "How are you?", wordCount: 3, audioDuration: 2, lastSuccessfulTrueEvaluation: { status: "completed", pronunciationScore: 99 } },
      // claims saved but the server has nothing for it → dropped
      0: { segmentIndex: 0, referenceText: "x", wordCount: 1, audioDuration: 1, trueEvaluation: { status: "completed", pronunciationScore: 99, attemptId: "att-ghost", persistence: "saved" } },
    };
    const merged = mergeServerResults(local, SERVER, TEXT);
    expect(merged[1]).toBeUndefined();
    expect(merged[0].trueEvaluation?.attemptId).toBe("att-old");
    expect(merged[0].lastSuccessfulTrueEvaluation?.pronunciationScore).toBe(64);
  });

  it("keeps a real but UNSAVED local result for an attempt the server has no result for — never as the saved score", () => {
    const unsaved = { status: "completed" as const, pronunciationScore: 88, attemptId: "att-new", seq: 1, persistence: "unsaved" as const };
    const merged = mergeServerResults(
      { 0: { segmentIndex: 0, referenceText: "Hello there.", wordCount: 2, audioDuration: 2, trueEvaluation: unsaved } },
      SERVER,
      TEXT
    );
    expect(merged[0].trueEvaluation).toEqual(unsaved);
    expect(merged[0].lastSuccessfulTrueEvaluation?.attemptId).toBe("att-old");
  });

  it("an unsaved local result the server has since stored is replaced by the server's copy", () => {
    const merged = mergeServerResults(
      { 0: { segmentIndex: 0, referenceText: "Hello there.", wordCount: 2, audioDuration: 2, trueEvaluation: { status: "completed", pronunciationScore: 1, attemptId: "att-old", persistence: "unsaved" } } },
      SERVER,
      TEXT
    );
    expect(merged[0].trueEvaluation).toMatchObject({ attemptId: "att-old", pronunciationScore: 64, persistence: "saved" });
  });
});

// ------------------------------------------------------ cache isolation

describe("16. cache scope and cleanup", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("is keyed by user, video, revision and round — another account never reads it", () => {
    const a = { userId: "user-a", videoId: "vid", transcriptId: "tr-1", roundId: "round-1" };
    saveShadowingEvaluations(a, { 0: { segmentIndex: 0, referenceText: "x", wordCount: 1, audioDuration: 1 } });
    expect(Object.keys(loadShadowingEvaluations(a))).toEqual(["0"]);
    expect(loadShadowingEvaluations({ ...a, userId: "user-b" })).toEqual({});
    expect(loadShadowingEvaluations({ ...a, roundId: "round-2" })).toEqual({});
    expect(loadShadowingEvaluations({ ...a, transcriptId: "tr-2" })).toEqual({});
  });

  it("never stores an in-flight state", () => {
    const s = { userId: "u", videoId: "v", transcriptId: "t", roundId: "r" };
    saveShadowingEvaluations(s, { 0: { segmentIndex: 0, referenceText: "", wordCount: 0, audioDuration: 0, trueEvaluation: { status: "processing" } } });
    expect(loadShadowingEvaluations(s)[0].trueEvaluation).toBeUndefined();
  });

  it("clearShadowingCache removes only Shadowing keys (current and pre-Phase-4)", () => {
    window.sessionStorage.setItem("dictation.shadowing.v2.u.v.t.r", "{}");
    window.sessionStorage.setItem("dictation.shadowing-evaluations.vid.tr", "{}");
    window.sessionStorage.setItem("dictation.active-session.vid", "{}");
    window.sessionStorage.setItem("unrelated", "1");
    clearShadowingCache();
    expect(Object.keys(window.sessionStorage)).toEqual(expect.arrayContaining(["dictation.active-session.vid", "unrelated"]));
    expect(window.sessionStorage.length).toBe(2);
  });

  it("only the no-round → adopted-round transition is accepted for a late result", () => {
    const none = scopeKey({ userId: "u", videoId: "v", transcriptId: "t", roundId: null });
    const r1 = scopeKey({ userId: "u", videoId: "v", transcriptId: "t", roundId: "r1" });
    const r2 = scopeKey({ userId: "u", videoId: "v", transcriptId: "t", roundId: "r2" });
    const other = scopeKey({ userId: "x", videoId: "v", transcriptId: "t", roundId: "r1" });
    expect(acceptsOrigin(none, r1)).toBe(true);
    expect(acceptsOrigin(r1, r1)).toBe(true);
    expect(acceptsOrigin(r1, r2)).toBe(false); // restart into another round
    expect(acceptsOrigin(none, other)).toBe(false); // another account
    expect(acceptsOrigin(scopeKey({ userId: "u", videoId: "w", transcriptId: "t", roundId: null }), r1)).toBe(false);
  });
});

// ------------------------------------------------- restore from server

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("14–15. useShadowingEvaluations", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    window.sessionStorage.clear();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const opts = (over: Partial<Parameters<typeof useShadowingEvaluations>[0]> = {}) => ({
    videoId: "vid",
    transcriptId: "tr-1",
    userId: "user-a",
    roundId: "round-1",
    eligibleSentences: 2 as number | null,
    recordedSentences: null as number | null,
    referenceTextFor: TEXT,
    ...over,
  });

  it("14. restores saved results from the server with an EMPTY local cache, without any local attempt id", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SERVER));
    const { result } = renderHook(() => useShadowingEvaluations(opts()), { wrapper: queryWrapper() });
    await waitFor(() => expect(result.current.evaluations[0]?.lastSuccessfulTrueEvaluation?.pronunciationScore).toBe(64));
    expect(fetchMock).toHaveBeenCalledWith("/api/practice/attempts?roundId=round-1", { method: "GET" });
    expect(result.current.summary.coverage.scoredSentences).toBe(1);
  });

  it("a round pinned to another revision is never merged into the displayed one", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...SERVER, transcriptId: "tr-OTHER" }));
    const { result } = renderHook(() => useShadowingEvaluations(opts()), { wrapper: queryWrapper() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.evaluations).toEqual({});
  });

  it("15. a result started in another round/account is ignored instead of landing on the visible one", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...SERVER, segments: [] }));
    const { result, rerender } = renderHook((p) => useShadowingEvaluations(p), { initialProps: opts(), wrapper: queryWrapper() });
    const originRound1 = result.current.scopeKey;
    rerender(opts({ roundId: "round-2" })); // restart into round 2
    await act(async () => {});
    act(() => result.current.completeWordMatch(originRound1, 0, { recognizedText: "x", accuracy: 1, completeness: 1, problemWords: [] }));
    expect(result.current.evaluations[0]).toBeUndefined();
    rerender(opts({ roundId: "round-2", userId: "user-b" })); // account switch
    await act(async () => {});
    const originB = result.current.scopeKey;
    act(() => result.current.completeWordMatch(originB, 1, { recognizedText: "x", accuracy: 1, completeness: 1, problemWords: [] }));
    expect(result.current.evaluations[1]?.wordMatch?.status).toBe("completed");
  });

  it("an unsaved score is shown for its take but never becomes the saved score; saving it later lets the server place it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...SERVER, segments: [] }));
    const { result } = renderHook(() => useShadowingEvaluations(opts()), { wrapper: queryWrapper() });
    await act(async () => {});
    const origin = result.current.scopeKey;
    act(() => result.current.completeTrueEvaluation(origin, 1, { pronunciationScore: 77, attemptId: "att-x", seq: 1, persistence: "unsaved", clipId: "blob:1" }));
    expect(result.current.evaluations[1].trueEvaluation?.persistence).toBe("unsaved");
    expect(result.current.evaluations[1].lastSuccessfulTrueEvaluation).toBeUndefined();
    expect(result.current.summary.coverage.scoredSentences).toBe(0);
    const saved = dto("att-x", 1, { azure: { status: "completed", seq: 1, pronunciationScore: 77, evaluatedAt: "2026-09-01T10:01:00Z", detail: { recognizedText: "how are you", words: [] } } });
    fetchMock.mockResolvedValue(
      jsonResponse({ ...SERVER, segments: [{ segmentIndex: 1, attemptCount: 1, latestAttempt: saved, latestSuccessfulAzureAttempt: saved, latestWordMatchAttempt: null, azureHistory: [] }] })
    );
    act(() => result.current.setTrueEvaluationPersistence(origin, 1, "att-x", "saved"));
    // Saved (not "unsaved") — but the recovery answer carries no recording
    // time, so the server places it: the summary waits for that read (R1).
    expect(result.current.evaluations[1].trueEvaluation?.persistence).toBe("saved");
    expect(result.current.evaluations[1].selectionPending).toEqual(["att-x"]);
    expect(result.current.summaryRefresh).toBe("pending");
    await waitFor(() => expect(result.current.evaluations[1].lastSuccessfulTrueEvaluation).toMatchObject({ pronunciationScore: 77, persistence: "saved" }));
    expect(result.current.summaryRefresh).toBeNull();
    expect(result.current.summary.coverage.scoredSentences).toBe(1);
  });
});

// ----------------------------------------------------- saving a take

describe("useShadowingRecordings", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const saved = (over: Record<string, unknown> = {}) =>
    jsonResponse({
      attemptId: "att-1",
      clientAttemptId: "c",
      roundId: "round-1",
      wasInserted: true,
      isPracticeValid: true,
      studySessionId: null,
      roundCompletedByThisRequest: false,
      roundStatus: "active",
      progress: { coverage: {} },
      coverage: {},
      ...over,
    });

  function setup(ctxRoundId: string | null = "round-1", applied = true) {
    const deps = {
      getRoundContext: jest.fn(() => ({ epoch: 1, roundId: ctxRoundId })),
      applyRoundUpdate: jest.fn(() => applied),
      onWordMatchPersisted: jest.fn(),
      onScorePersistence: jest.fn(),
      onRoundCompleted: jest.fn(),
    };
    const hook = renderHook(() => useShadowingRecordings(deps));
    return { deps, hook };
  }
  const take = { clipUrl: "blob:1", userId: "user-a", videoId: "vid", transcriptId: "tr-1", segmentIndex: 3, durationSec: 2.4, origin: "o" };

  it("1. saves a finished take immediately with its captured identity; progress comes only from the server", async () => {
    fetchMock.mockResolvedValue(saved({ roundCompletedByThisRequest: true, roundStatus: "completed" }));
    const { deps, hook } = setup();
    act(() => hook.result.current.saveRecording(take));
    expect(hook.result.current.view("blob:1")?.status).toBe("saving");
    await waitFor(() => expect(hook.result.current.view("blob:1")?.status).toBe("saved"));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ youtubeVideoId: "vid", roundId: "round-1", transcriptId: "tr-1", segmentIndex: 3, recordingDurationSec: 2.4 });
    expect(body.clientAttemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(deps.applyRoundUpdate).toHaveBeenCalledWith({ epoch: 1, roundId: "round-1" }, expect.objectContaining({ roundId: "round-1" }));
    expect(deps.onRoundCompleted).toHaveBeenCalledTimes(1);
  });

  it("3. a failed save stays visibly unsaved; the retry reuses the SAME clientAttemptId; a new take gets a new one", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(saved());
    const { hook } = setup();
    act(() => hook.result.current.saveRecording(take));
    await waitFor(() => expect(hook.result.current.view("blob:1")?.status).toBe("failed"));
    expect(hook.result.current.view("blob:1")?.error).toMatch(/Couldn't reach the server/);
    act(() => hook.result.current.retrySave("blob:1"));
    await waitFor(() => expect(hook.result.current.view("blob:1")?.status).toBe("saved"));
    const ids = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).clientAttemptId);
    expect(ids[0]).toBe(ids[1]);
    act(() => hook.result.current.saveRecording({ ...take, clipUrl: "blob:2" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).clientAttemptId).not.toBe(ids[0]);
    // the same take is never saved twice
    act(() => hook.result.current.saveRecording(take));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maintenance is shown as retryable, never as saved", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "paused", code: "write_gate_paused", retryable: true }, 503));
    const { hook, deps } = setup();
    act(() => hook.result.current.saveRecording(take));
    await waitFor(() => expect(hook.result.current.view("blob:1")?.status).toBe("failed"));
    expect(hook.result.current.view("blob:1")).toMatchObject({ retryable: true });
    expect(deps.applyRoundUpdate).not.toHaveBeenCalled();
  });

  it("Word Match is sent only once the take has a server id, and against that attempt", async () => {
    let resolveSave: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (resolveSave = r))).mockResolvedValue(jsonResponse({ applied: true }));
    const { hook, deps } = setup();
    act(() => hook.result.current.saveRecording(take));
    act(() => hook.result.current.setWordMatchOutcome("blob:1", { status: "completed", recognizedText: "hello" }));
    expect(fetchMock).toHaveBeenCalledTimes(1); // still only the save
    await act(async () => resolveSave(saved()));
    await waitFor(() => expect(deps.onWordMatchPersisted).toHaveBeenCalled());
    expect(fetchMock.mock.calls[1][0]).toBe("/api/practice/attempt/att-1/word-match");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ status: "completed", recognizedText: "hello" });
    expect(deps.onWordMatchPersisted).toHaveBeenCalledWith("o", 3, { clipUrl: "blob:1", attemptId: "att-1" }, true);
  });

  it("15. a save that returns after a context change is not applied to the new round, and never celebrates", async () => {
    fetchMock.mockResolvedValue(saved({ roundCompletedByThisRequest: true }));
    const { hook, deps } = setup("round-1", false); // the page moved on (applyRoundUpdate refuses)
    act(() => hook.result.current.saveRecording(take));
    await waitFor(() => expect(deps.applyRoundUpdate).toHaveBeenCalled());
    expect(deps.onRoundCompleted).not.toHaveBeenCalled();
  });

  it("ensureSaved waits for an in-flight save; an unsaved take yields null (no evaluation without an attempt id)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const { hook } = setup();
    act(() => hook.result.current.saveRecording(take));
    let id: string | null = "x";
    await act(async () => {
      id = await hook.result.current.ensureSaved("blob:1");
    });
    expect(id).toBeNull();
    await waitFor(() => expect(hook.result.current.view("blob:1")?.status).toBe("failed"));
  });

  it("12. a recovery token is kept in memory only and relayed as-is; success marks the score saved", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ persisted: true, attemptId: "att-1", seq: 2 }));
    const { hook, deps } = setup();
    jest.useFakeTimers();
    try {
      act(() => hook.result.current.rememberRecovery("att-1", "opaque.token", "o", 3));
      expect(hook.result.current.canRetryScoreSave("att-1")).toBe(true);
      await act(async () => {
        jest.advanceTimersByTime(1600);
      });
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => expect(deps.onScorePersistence).toHaveBeenCalledWith("o", 3, "att-1", "saved"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ recoveryToken: "opaque.token" });
    expect(hook.result.current.canRetryScoreSave("att-1")).toBe(false);
    expect(JSON.stringify(window.sessionStorage)).not.toContain("opaque.token");
  });

  it("13. a superseded recovery marks the score superseded and drops the token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "newer", code: "recovery_superseded" }, 409));
    const { hook, deps } = setup();
    act(() => hook.result.current.rememberRecovery("att-1", "t", "o", 3));
    await act(async () => {
      await hook.result.current.retryScoreSave("att-1");
    });
    expect(deps.onScorePersistence).toHaveBeenCalledWith("o", 3, "att-1", "superseded");
    expect(hook.result.current.canRetryScoreSave("att-1")).toBe(false);
  });

  it("16. reset (sign-out / account switch) forgets takes and tokens", async () => {
    fetchMock.mockResolvedValue(saved());
    const { hook } = setup();
    act(() => hook.result.current.saveRecording(take));
    await waitFor(() => expect(hook.result.current.view("blob:1")?.status).toBe("saved"));
    act(() => hook.result.current.rememberRecovery("att-9", "t", "o", 1));
    act(() => hook.result.current.reset());
    expect(hook.result.current.view("blob:1")).toBeNull();
    expect(hook.result.current.canRetryScoreSave("att-9")).toBe(false);
  });
});
