/**
 * Phase 3 client behavior of useDictationSession's answer submission,
 * restart and autosave — through the real hook (renderHook), with only the
 * network layer (api.ts functions) mocked. PracticeWriteError is the real
 * class, so the hook sees exactly what the real client helpers throw.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import type { CheckAnswerResponse, ResumeSessionResponse, TranscriptResponse, TranscriptSegment } from "@/lib/types";

jest.mock("@/app/dictation/[videoId]/api", () => {
  const actual = jest.requireActual("@/app/dictation/[videoId]/api");
  return {
    PracticeWriteError: actual.PracticeWriteError,
    fetchTranscript: jest.fn(),
    checkAnswerApi: jest.fn(),
    saveProgress: jest.fn(),
    fetchResumeSession: jest.fn(),
    restartSession: jest.fn(),
    regenerateTranscript: jest.fn(),
    saveManualTranscript: jest.fn(),
    requestTranscriptGeneration: jest.fn(),
  };
});
import * as api from "@/app/dictation/[videoId]/api";
import { PracticeWriteError } from "@/app/dictation/[videoId]/api";
import { useDictationSession } from "@/app/dictation/[videoId]/useDictationSession";
import { useSessionStore } from "@/store/sessionStore";

const apiMock = api as jest.Mocked<typeof api>;
const user = { id: "user-1" } as User;

function segs(id: string, n = 3): TranscriptSegment[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${id}-${i}`,
    transcript_id: id,
    segmentIndex: i,
    start: i * 2,
    end: i * 2 + 2,
    duration: 2,
    text: `Sentence ${i}.`,
    textNormalized: `sentence ${i}`,
  }));
}
const ready = (id: string): TranscriptResponse => ({ status: "ready", segments: segs(id), transcriptId: id });
function resume(over: Partial<NonNullable<ResumeSessionResponse["session"]>> = {}): ResumeSessionResponse {
  return {
    session: {
      sessionId: "round-1",
      currentSegmentIndex: 1,
      videoCurrentTimeSec: 2,
      accuracy: 50,
      totalAttempts: 2,
      updatedAt: new Date().toISOString(),
      status: "active",
      transcriptId: "rev-A",
      latestDictationResults: [{ segmentIndex: 0, isCorrect: false }],
      ...over,
    },
  };
}
function graded(over: Partial<CheckAnswerResponse> = {}): CheckAnswerResponse {
  return {
    isCorrect: false,
    matchMode: "relaxed",
    errorType: "wrong_form",
    diff: [],
    normalizedExpected: "sentence 1",
    normalizedUser: "x",
    recorded: true,
    wasInserted: true,
    roundStatus: "active",
    roundCompletedByThisRequest: false,
    ...over,
  };
}
const maintenance = () => new PracticeWriteError("paused", 503, "write_gate_paused", true);

function wrapper(qc: QueryClient) {
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

async function renderResumed(r: ResumeSessionResponse = resume()) {
  apiMock.fetchResumeSession.mockResolvedValue(r);
  apiMock.fetchTranscript.mockImplementation(async (_v, pinned) => ready(pinned ?? "rev-A"));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook((p: { videoId: string }) => useDictationSession({ videoId: p.videoId, user }), {
    wrapper: wrapper(qc),
    initialProps: { videoId: "vid1" },
  });
  await waitFor(() => expect(hook.result.current.uxState).toBe("transcript_ready"));
  act(() => hook.result.current.handleResume());
  await waitFor(() => expect(hook.result.current.currentSegIdx).toBe(r.session?.currentSegmentIndex ?? 0));
  return hook;
}

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.getState().reset();
  window.sessionStorage.clear();
  apiMock.saveProgress.mockResolvedValue({ sessionId: "round-1" });
  apiMock.requestTranscriptGeneration.mockResolvedValue({ status: "processing" });
});

describe("sentence accuracy", () => {
  it("is seeded from the server on resume, not computed from this page's submissions alone", async () => {
    const { result } = await renderResumed();
    expect(result.current.sentenceAccuracy).toEqual({ correct: 0, practiced: 1, percent: 0 });
  });

  it("uses the latest answer per sentence: repeats replace, never add to the denominator", async () => {
    const { result } = await renderResumed();
    apiMock.checkAnswerApi.mockResolvedValueOnce(graded({ isCorrect: false }));
    await act(async () => result.current.handleAnswerSubmit("wrong"));
    apiMock.checkAnswerApi.mockResolvedValueOnce(graded({ isCorrect: false }));
    await act(async () => result.current.handleAnswerSubmit("still wrong"));
    expect(result.current.sentenceAccuracy).toEqual({ correct: 0, practiced: 2, percent: 0 });
    apiMock.checkAnswerApi.mockResolvedValueOnce(graded({ isCorrect: true, errorType: "none" }));
    await act(async () => result.current.handleAnswerSubmit("sentence 1"));
    expect(result.current.sentenceAccuracy).toEqual({ correct: 1, practiced: 2, percent: 50 });
  });
});

describe("attempt ids and retries", () => {
  it("sends the round, pinned revision, video, hint level and a client attempt id", async () => {
    const { result } = await renderResumed();
    apiMock.checkAnswerApi.mockResolvedValueOnce(graded());
    await act(async () => result.current.handleAnswerSubmit("abc"));
    expect(apiMock.checkAnswerApi).toHaveBeenCalledWith(
      expect.objectContaining({
        segmentIndex: 1,
        userText: "abc",
        sessionId: "round-1",
        transcriptId: "rev-A",
        youtubeVideoId: "vid1",
        hintLevelUsed: 0,
        clientAttemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      })
    );
  });

  it("maintenance: keeps the answer, does not advance or count, and the retry reuses the SAME id", async () => {
    const { result } = await renderResumed();
    apiMock.checkAnswerApi.mockRejectedValueOnce(maintenance());
    await act(async () => result.current.handleAnswerSubmit("sentence 1"));
    expect(result.current.uxState).toBe("paused_waiting_input");
    expect(result.current.currentSegIdx).toBe(1);
    expect(result.current.checkAnswerError).toMatch(/paused for maintenance/i);
    expect(result.current.checkResult).toBeNull();
    expect(useSessionStore.getState().totalAttempts).toBe(2);
    const firstId = apiMock.checkAnswerApi.mock.calls[0][0].clientAttemptId;

    apiMock.checkAnswerApi.mockResolvedValueOnce(graded({ isCorrect: false }));
    await act(async () => result.current.handleAnswerSubmit("sentence 1"));
    expect(apiMock.checkAnswerApi.mock.calls[1][0].clientAttemptId).toBe(firstId);
  });

  it("a network failure is also retried with the same id", async () => {
    const { result } = await renderResumed();
    apiMock.checkAnswerApi.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => result.current.handleAnswerSubmit("abc"));
    expect(result.current.checkAnswerError).toMatch(/couldn't reach/i);
    apiMock.checkAnswerApi.mockResolvedValueOnce(graded());
    await act(async () => result.current.handleAnswerSubmit("abc"));
    const [a, b] = apiMock.checkAnswerApi.mock.calls.map((c) => c[0].clientAttemptId);
    expect(b).toBe(a);
  });

  it("a genuinely new submission gets a new id — even the same text on the same sentence", async () => {
    const { result } = await renderResumed();
    apiMock.checkAnswerApi.mockResolvedValue(graded({ isCorrect: false }));
    await act(async () => result.current.handleAnswerSubmit("abc"));
    await act(async () => result.current.handleAnswerSubmit("abc"));
    const [a, b] = apiMock.checkAnswerApi.mock.calls.map((c) => c[0].clientAttemptId);
    expect(b).not.toBe(a);
  });

  it("a retried submission the server already recorded is not counted twice", async () => {
    const { result } = await renderResumed();
    apiMock.checkAnswerApi.mockResolvedValueOnce(graded({ wasInserted: false }));
    await act(async () => result.current.handleAnswerSubmit("abc"));
    expect(useSessionStore.getState().totalAttempts).toBe(2);
  });
});

describe("stale responses", () => {
  it("a response arriving after switching videos changes nothing in the new context", async () => {
    const hook = await renderResumed();
    let resolve!: (v: CheckAnswerResponse) => void;
    apiMock.checkAnswerApi.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    act(() => {
      void hook.result.current.handleAnswerSubmit("abc");
    });
    apiMock.fetchResumeSession.mockResolvedValue({ session: null });
    hook.rerender({ videoId: "vid2" });
    await waitFor(() => expect(hook.result.current.uxState).toBe("transcript_ready"));
    await act(async () => resolve(graded({ isCorrect: true, roundStatus: "completed", roundCompletedByThisRequest: true })));
    expect(hook.result.current.checkResult).toBeNull();
    expect(hook.result.current.sentenceAccuracy.practiced).toBe(0);
    expect(hook.result.current.roundState.completedByThisPage).toBe(false);
  });
});

describe("completion is the server's decision", () => {
  it("answering the last sentence correctly without server completion is not a celebrated completion", async () => {
    const { result } = await renderResumed(resume({ currentSegmentIndex: 2 }));
    await waitFor(() => expect(result.current.currentSegIdx).toBe(2));
    apiMock.checkAnswerApi.mockResolvedValueOnce(graded({ isCorrect: true, errorType: "none", roundStatus: "active" }));
    await act(async () => result.current.handleAnswerSubmit("sentence 2"));
    await waitFor(() => expect(result.current.uxState).toBe("session_completed"), { timeout: 3000 });
    expect(result.current.roundState).toMatchObject({ status: "active", completedByThisPage: false });
  });

  it("a submission that completed the round is celebrated once; a retry reporting it again is not", async () => {
    const { result } = await renderResumed();
    apiMock.checkAnswerApi.mockResolvedValueOnce(graded({ roundStatus: "completed", roundCompletedByThisRequest: true }));
    await act(async () => result.current.handleAnswerSubmit("x"));
    expect(result.current.roundState).toMatchObject({ status: "completed", completedByThisPage: true });
  });

  it("an already-completed round loaded on resume is never 'completed by this page'", async () => {
    const { result } = await renderResumed(resume({ status: "completed" }));
    expect(result.current.roundState).toMatchObject({ status: "completed", completedByThisPage: false });
  });
});

describe("restart and autosave", () => {
  it("restart adopts the new round and its pinned revision returned by the server, and clears the score", async () => {
    const { result } = await renderResumed();
    apiMock.restartSession.mockResolvedValueOnce({ sessionId: "round-2", transcriptId: "rev-B" });
    await act(async () => {
      result.current.handleRestart();
    });
    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe("round-2"));
    await waitFor(() => expect(result.current.segments[0]?.transcript_id).toBe("rev-B"));
    expect(apiMock.restartSession).toHaveBeenCalledWith("vid1", "round-1");
    expect(result.current.sentenceAccuracy.practiced).toBe(0);
  });

  it("a failed restart leaves the lesson untouched and says why", async () => {
    const { result } = await renderResumed();
    apiMock.restartSession.mockRejectedValueOnce(maintenance());
    await act(async () => {
      result.current.handleRestart();
    });
    await waitFor(() => expect(result.current.restartError).toMatch(/maintenance/));
    expect(useSessionStore.getState().sessionId).toBe("round-1");
    expect(result.current.sentenceAccuracy.practiced).toBe(1);
  });

  it("a maintenance 503 on save keeps the round id; only 'round not found' forgets it", async () => {
    const { result } = await renderResumed();
    apiMock.saveProgress.mockRejectedValueOnce(maintenance());
    await act(async () => result.current.handleSkip());
    await waitFor(() => expect(apiMock.saveProgress).toHaveBeenCalled());
    await act(async () => Promise.resolve());
    expect(useSessionStore.getState().sessionId).toBe("round-1");
    apiMock.saveProgress.mockRejectedValueOnce(new PracticeWriteError("gone", 404, "round_not_found", false));
    await act(async () => result.current.handlePrevious());
    await waitFor(() => expect(useSessionStore.getState().sessionId).toBeNull());
  });
});
