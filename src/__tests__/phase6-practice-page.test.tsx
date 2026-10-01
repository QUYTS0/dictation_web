/**
 * Phase 6 practice-page behavior (hooks with the network mocked — not a real
 * browser): last-mode precedence, completed rounds reopen as reviewable
 * (never restarted), review never writes, the end-of-round state is left on
 * a mode switch, and confirmed writes mark the account-wide views stale.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import type { ResumeSessionResponse, TranscriptResponse, TranscriptSegment } from "@/lib/types";
import { useSessionStore } from "@/store/sessionStore";
import { dashboardKeys } from "@/lib/queries/dashboard";
import { historySessionsKeys } from "@/lib/queries/historySessions";
import { roundReportKeys } from "@/lib/queries/roundReport";
import { videoLibraryKeys } from "@/lib/queries/videoLibrary";

const replace = jest.fn();
let search = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: jest.fn() }),
  useSearchParams: () => search,
}));
jest.mock("@/app/dictation/[videoId]/api", () => ({
  fetchTranscript: jest.fn(),
  checkAnswerApi: jest.fn(),
  saveProgress: jest.fn(),
  fetchResumeSession: jest.fn(),
  restartSession: jest.fn(),
  regenerateTranscript: jest.fn(),
  saveManualTranscript: jest.fn(),
  requestTranscriptGeneration: jest.fn(),
  PracticeWriteError: class extends Error {},
}));
import * as api from "@/app/dictation/[videoId]/api";
import { useDictationSession } from "@/app/dictation/[videoId]/useDictationSession";
import { useInputModePreference } from "@/app/dictation/[videoId]/useInputModePreference";
const apiMock = api as jest.Mocked<typeof api>;

const user = { id: "user-1" } as User;
const segs = (id: string): TranscriptSegment[] =>
  Array.from({ length: 4 }, (_, i) => ({
    id: `${id}-${i}`,
    transcript_id: id,
    segmentIndex: i,
    start: i * 2,
    end: i * 2 + 2,
    duration: 2,
    text: `Sentence ${i}.`,
    textNormalized: `sentence ${i}`,
  }));
const ready = (id: string): TranscriptResponse => ({ status: "ready", segments: segs(id), transcriptId: id });
const completedRound: ResumeSessionResponse = {
  lastMode: null,
  session: {
    sessionId: "round-done",
    currentSegmentIndex: 3,
    videoCurrentTimeSec: 6.5,
    accuracy: 75,
    totalAttempts: 4,
    updatedAt: new Date().toISOString(),
    status: "completed",
    transcriptId: "rev-A",
  },
};

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  jest.clearAllMocks();
  search = new URLSearchParams();
  window.localStorage.clear();
  window.sessionStorage.clear();
  useSessionStore.getState().reset();
  apiMock.fetchTranscript.mockImplementation(async (_v, pinned) => ready(pinned ?? "rev-A"));
  apiMock.saveProgress.mockResolvedValue({ sessionId: "round-new" });
  apiMock.restartSession.mockResolvedValue({ sessionId: "round-2", transcriptId: "rev-A" });
  apiMock.requestTranscriptGeneration.mockResolvedValue({ status: "processing" });
});

describe("last mode precedence", () => {
  function usePage(videoId = "vid1") {
    const mode = useInputModePreference(videoId);
    const session = useDictationSession({
      videoId,
      user,
      autoEnterPaused: mode.inputMode !== "dictation",
      inputMode: mode.inputMode,
      onServerLastMode: mode.applyServerMode,
    });
    return { mode, session };
  }

  it("the server's saved last mode drives a normal reopen (no ?mode=), over this browser's local fallback", async () => {
    window.localStorage.setItem("dictation.input-mode.vid1", "listening");
    apiMock.fetchResumeSession.mockResolvedValue({ session: null, lastMode: "shadowing" });
    const { result } = renderHook(() => usePage(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.mode.inputMode).toBe("shadowing"));
    expect(window.localStorage.getItem("dictation.input-mode.vid1")).toBe("shadowing");
  });

  it("an explicit ?mode= link wins over the server's last mode", async () => {
    search = new URLSearchParams("mode=listening");
    apiMock.fetchResumeSession.mockResolvedValue({ session: null, lastMode: "shadowing" });
    const { result } = renderHook(() => usePage(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.session.uxState).toBe("paused_waiting_input"));
    expect(result.current.mode.inputMode).toBe("listening");
  });

  it("a mode the user already picked on this page is never overridden by a late server answer", async () => {
    let answer!: (r: ResumeSessionResponse) => void;
    apiMock.fetchResumeSession.mockReturnValue(new Promise((r) => (answer = r)) as never);
    const { result } = renderHook(() => usePage(), { wrapper: wrapper(newClient()) });
    act(() => result.current.mode.setInputMode("listening"));
    await act(async () => answer({ session: null, lastMode: "shadowing" }));
    expect(result.current.mode.inputMode).toBe("listening");
  });
});

describe("completed rounds reopen as reviewable — never restarted", () => {
  it("opening a completed round creates no round, restarts nothing and saves nothing; reviewing a sentence doesn't either", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(completedRound);
    const { result } = renderHook(() => useDictationSession({ videoId: "vid1", user }), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.uxState).toBe("transcript_ready"));
    expect(result.current.roundState.status).toBe("completed");

    act(() => result.current.reviewSegment(2));
    expect(result.current).toMatchObject({ uxState: "paused_waiting_input", currentSegIdx: 2, currentRoundId: "round-done" });
    expect(useSessionStore.getState().sessionId).toBe("round-done"); // the SAME completed round
    expect(apiMock.saveProgress).not.toHaveBeenCalled();
    expect(apiMock.restartSession).not.toHaveBeenCalled();
    expect(apiMock.checkAnswerApi).not.toHaveBeenCalled(); // no practice credit without an actual answer
  });

  it("only the explicit restart creates a new round; old and new round reports, Library and History are marked stale", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(completedRound);
    const qc = newClient();
    const { result } = renderHook(() => useDictationSession({ videoId: "vid1", user }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.uxState).toBe("transcript_ready"));
    for (const key of [
      roundReportKeys.report("user-1", "round-done"),
      roundReportKeys.report("user-1", "round-2"),
      videoLibraryKeys.list("user-1", "all"),
      historySessionsKeys.list("user-1", { videoId: "" }),
      dashboardKeys.summary("user-1"),
    ]) qc.setQueryData(key, { cached: true });
    await act(async () => result.current.handleRestart());
    expect(apiMock.restartSession).toHaveBeenCalledWith("vid1", "round-done");
    await waitFor(() => expect(qc.getQueryState(roundReportKeys.report("user-1", "round-done"))?.isInvalidated).toBe(true));
    expect(qc.getQueryState(roundReportKeys.report("user-1", "round-2"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(videoLibraryKeys.list("user-1", "all"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(historySessionsKeys.list("user-1", { videoId: "" }))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(dashboardKeys.summary("user-1"))?.isInvalidated).toBe(true);
    expect(useSessionStore.getState().sessionId).toBe("round-2");
  });
});

describe("partial progress refreshes the account views (not only completion)", () => {
  it("a recorded answer marks Dashboard, Library, History and THIS round's report stale; an unrecorded one doesn't", async () => {
    apiMock.fetchResumeSession.mockResolvedValue({
      session: { ...completedRound.session!, sessionId: "round-A", status: "active", currentSegmentIndex: 0, videoCurrentTimeSec: 0 },
    });
    const qc = newClient();
    const { result } = renderHook(() => useDictationSession({ videoId: "vid1", user }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.uxState).toBe("transcript_ready"));
    act(() => result.current.reviewSegment(0)); // adopt the round, sentence 1
    const keys = [
      dashboardKeys.summary("user-1"),
      videoLibraryKeys.list("user-1", "all"),
      historySessionsKeys.list("user-1", { videoId: "" }),
      roundReportKeys.report("user-1", "round-A"),
      roundReportKeys.report("user-1", "other-round"),
    ];
    for (const key of keys) qc.setQueryData(key, { cached: true });

    apiMock.checkAnswerApi.mockResolvedValueOnce({ isCorrect: false, recorded: false, diff: [], normalizedUser: "x", normalizedExpected: "y", matchMode: "relaxed", errorType: "wrong_word" } as never);
    await act(async () => result.current.handleAnswerSubmit("x"));
    expect(qc.getQueryState(keys[0])?.isInvalidated).toBe(false);

    apiMock.checkAnswerApi.mockResolvedValueOnce({
      isCorrect: false,
      recorded: true,
      roundStatus: "active",
      diff: [],
      normalizedUser: "x",
      normalizedExpected: "y",
      matchMode: "relaxed",
      errorType: "wrong_word",
    } as never);
    await act(async () => result.current.handleAnswerSubmit("x y"));
    for (const key of keys.slice(0, 4)) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys[4])?.isInvalidated).toBe(false); // another round's report is untouched
  });
});

describe("leaving the end-of-round state (D17)", () => {
  it("exitCompletedView turns session_completed into the practicing view; it is a no-op elsewhere", async () => {
    apiMock.fetchResumeSession.mockResolvedValue({ session: null });
    apiMock.checkAnswerApi.mockResolvedValue({ isCorrect: true, recorded: false, diff: [], normalizedUser: "", normalizedExpected: "", matchMode: "relaxed" } as never);
    const { result } = renderHook(() => useDictationSession({ videoId: "vid1", user }), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.uxState).toBe("transcript_ready"));
    act(() => result.current.exitCompletedView());
    expect(result.current.uxState).toBe("transcript_ready");
    act(() => result.current.jumpToSegment(3)); // last sentence
    await act(async () => result.current.handleAnswerSubmit("Sentence 3."));
    await waitFor(() => expect(result.current.uxState).toBe("session_completed"), { timeout: 3000 });
    act(() => result.current.exitCompletedView());
    expect(result.current.uxState).toBe("paused_waiting_input");
  });
});

describe("Listening needs no round; round practice gets one", () => {
  it("a Listening-only visit creates no round; switching to Dictation creates it at the selected sentence", async () => {
    apiMock.fetchResumeSession.mockResolvedValue({ session: null });
    const { result, rerender } = renderHook(
      ({ mode }: { mode: "listening" | "dictation" }) =>
        useDictationSession({ videoId: "vid1", user, autoEnterPaused: mode !== "dictation", inputMode: mode }),
      { wrapper: wrapper(newClient()), initialProps: { mode: "listening" as "listening" | "dictation" } }
    );
    await waitFor(() => expect(result.current.uxState).toBe("paused_waiting_input"));
    act(() => result.current.jumpToSegment(2));
    expect(apiMock.saveProgress).not.toHaveBeenCalled();

    rerender({ mode: "dictation" });
    await waitFor(() => expect(apiMock.saveProgress).toHaveBeenCalledTimes(1));
    expect(apiMock.saveProgress.mock.calls[0][1]).toBe(2); // the selected sentence
    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe("round-new"));
  });
});
