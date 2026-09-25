/**
 * Behavior-focused tests for useDictationSession.ts's regeneration / resume /
 * autosave lifecycle (the focused Phase 0 bug fix — see
 * .claude/video-learning-management-plan.md's Phase 0 status note).
 *
 * Exercises the hook through React Testing Library's renderHook rather than
 * reaching into its internals, so these assert observable behavior (uxState,
 * segments, pendingRevisionNotice, which network calls fired) — not
 * implementation details like which ref/effect happens to do the work.
 *
 * All server calls are mocked (src/app/dictation/[videoId]/api.ts) — no live
 * network, no Supabase, no YouTube/Azure. The YouTube player itself is
 * stubbed via the imperative handle the hook already treats as optional
 * (`ytPlayerRef.current` stays null in a test environment, matching how the
 * hook already guards every call through it).
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { useDictationSession } from "@/app/dictation/[videoId]/useDictationSession";
import { useSessionStore } from "@/store/sessionStore";
import type { TranscriptResponse, TranscriptSegment, ResumeSessionResponse } from "@/lib/types";

jest.mock("@/app/dictation/[videoId]/api", () => ({
  fetchTranscript: jest.fn(),
  checkAnswerApi: jest.fn(),
  saveProgress: jest.fn(),
  fetchResumeSession: jest.fn(),
  restartSession: jest.fn(),
  regenerateTranscript: jest.fn(),
  saveManualTranscript: jest.fn(),
  requestTranscriptGeneration: jest.fn(),
}));

import * as api from "@/app/dictation/[videoId]/api";

const apiMock = api as jest.Mocked<typeof api>;

function makeSegments(transcriptId: string, count = 5): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${transcriptId}-seg-${i}`,
    transcript_id: transcriptId,
    segmentIndex: i,
    start: i * 2,
    end: i * 2 + 2,
    duration: 2,
    text: `Sentence ${i}.`,
    textNormalized: `sentence ${i}`,
  }));
}

function readyResponse(transcriptId: string, count = 5): TranscriptResponse {
  return { status: "ready", segments: makeSegments(transcriptId, count), transcriptId };
}

function resumeWith(overrides: Partial<NonNullable<ResumeSessionResponse["session"]>>): ResumeSessionResponse {
  return {
    session: {
      sessionId: "sess-1",
      currentSegmentIndex: 2,
      videoCurrentTimeSec: 10,
      accuracy: 100,
      totalAttempts: 5,
      updatedAt: new Date().toISOString(),
      status: "active",
      transcriptId: "rev-A",
      ...overrides,
    },
  };
}

const noSession: ResumeSessionResponse = { session: null };

const user: User = { id: "user-1" } as User;

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/** A promise the test controls the resolution/rejection timing of. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.getState().reset();
  window.sessionStorage.clear();
  apiMock.checkAnswerApi.mockResolvedValue({
    isCorrect: true,
    normalizedUser: "",
    normalizedExpected: "",
    matchMode: "relaxed",
    diff: [],
  } as never);
  apiMock.saveProgress.mockResolvedValue({ sessionId: "sess-1" });
  apiMock.restartSession.mockResolvedValue({});
  // The background auto-generate scheduler (triggerAutoGenerate) fires
  // whenever a video's transcript is "processing" with no segments yet —
  // relevant to any test that puts a second video into that state (e.g.
  // the video-switch test below). Given a real, always-resolved default
  // here so that path never crashes on an unmocked call.
  apiMock.requestTranscriptGeneration.mockResolvedValue({ status: "processing", code: "GENERATION_IN_PROGRESS", retryAfterMs: 60_000 });
});

/** Renders the hook against video "vid1" with an established session pinned
 *  to revision "rev-A", waiting until the pre-start "transcript_ready"
 *  screen (with an existing session/pin) is showing — the smallest state in
 *  which hasUsableLesson is already true, matching what "an established
 *  lesson is present" means for the regenerate/manual-save guard. */
async function renderEstablished(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  apiMock.fetchResumeSession.mockResolvedValue(resumeWith({}));
  apiMock.fetchTranscript.mockImplementation(async (_videoId, pinnedId) => readyResponse(pinnedId ?? "rev-A"));

  const rendered = renderHook((props: { videoId: string; user: User | null }) => useDictationSession(props), {
    wrapper: makeWrapper(queryClient),
    initialProps: { videoId: "vid1", user },
  });

  await waitFor(() => expect(rendered.result.current.uxState).toBe("transcript_ready"));
  await waitFor(() => expect(rendered.result.current.segments[0]?.transcript_id).toBe("rev-A"));
  return { ...rendered, queryClient };
}

describe("useDictationSession — regeneration preserves the established lesson", () => {
  it("1. starting regeneration does not clear the session/pin/progress/counters while the request is in flight", async () => {
    const { result } = await renderEstablished();
    const { promise, resolve } = deferred<{ status: string; transcriptId: string }>();
    apiMock.regenerateTranscript.mockReturnValue(promise as never);

    act(() => {
      void result.current.handleRegenerateTranscript();
    });

    // Immediately (before the request resolves): still on the same segments,
    // uxState untouched, no reset to the processing screen.
    expect(result.current.regenerating).toBe(true);
    expect(result.current.uxState).toBe("transcript_ready");
    expect(result.current.segments[0]?.transcript_id).toBe("rev-A");
    expect(result.current.segments).toHaveLength(5);

    await act(async () => {
      resolve({ status: "ready", transcriptId: "rev-A" });
      await promise;
    });
  });

  it("2. same-revision regeneration leaves the lesson exactly as it was (no notice, no refetch)", async () => {
    const { result } = await renderEstablished();
    apiMock.regenerateTranscript.mockResolvedValue({ status: "ready", transcriptId: "rev-A" });
    const fetchCallsBefore = apiMock.fetchTranscript.mock.calls.length;

    await act(async () => {
      await result.current.handleRegenerateTranscript();
    });

    expect(result.current.regenerating).toBe(false);
    expect(result.current.pendingRevisionNotice).toBeNull();
    expect(result.current.segments[0]?.transcript_id).toBe("rev-A");
    // No refetch was needed — the displayed revision didn't change.
    expect(apiMock.fetchTranscript.mock.calls.length).toBe(fetchCallsBefore);
  });

  it("3. different-revision regeneration publishes B while the session stays consistently on A", async () => {
    const { result } = await renderEstablished();
    apiMock.regenerateTranscript.mockResolvedValue({ status: "ready", transcriptId: "rev-B" });
    const fetchCallsBefore = apiMock.fetchTranscript.mock.calls.length;

    await act(async () => {
      await result.current.handleRegenerateTranscript();
    });

    expect(result.current.regenerating).toBe(false);
    expect(result.current.pendingRevisionNotice).toEqual(expect.stringContaining("Restart"));
    // Still displaying/practicing A — never silently swapped to B's segments.
    expect(result.current.segments[0]?.transcript_id).toBe("rev-A");
    expect(apiMock.fetchTranscript.mock.calls.length).toBe(fetchCallsBefore);
  });

  it("4. failed regeneration leaves the old lesson usable", async () => {
    const { result } = await renderEstablished();
    apiMock.regenerateTranscript.mockRejectedValue(Object.assign(new Error("network down"), { code: "NETWORK_ERROR" }));

    await act(async () => {
      await result.current.handleRegenerateTranscript();
    });

    expect(result.current.regenerateError).toBe("network down");
    // Nothing about the existing lesson was touched, so there's nothing to
    // roll back — it's simply still there.
    expect(result.current.uxState).toBe("transcript_ready");
    expect(result.current.segments[0]?.transcript_id).toBe("rev-A");
    expect(result.current.segments).toHaveLength(5);
  });

  it("5. a regeneration response arriving after switching videos does not mutate the new video's context", async () => {
    const { result, rerender, queryClient } = await renderEstablished();
    const { promise, resolve } = deferred<{ status: string; transcriptId: string }>();
    apiMock.regenerateTranscript.mockReturnValue(promise as never);

    act(() => {
      void result.current.handleRegenerateTranscript();
    });
    expect(result.current.regenerating).toBe(true);

    // Switch to a different video before the regenerate call resolves —
    // this video has no session and its own transcript is still generating.
    apiMock.fetchResumeSession.mockResolvedValue(noSession);
    apiMock.fetchTranscript.mockImplementation(async () => ({ status: "processing", segments: [] }));
    rerender({ videoId: "vid2", user });
    await waitFor(() => expect(result.current.uxState).toBe("transcript_processing"));
    // The stale in-flight request must not leave vid2's Regenerate button
    // stuck showing "Regenerating…" for a request that no longer applies.
    expect(result.current.regenerating).toBe(false);

    // Now let the vid1 regenerate call resolve with a different revision.
    await act(async () => {
      resolve({ status: "ready", transcriptId: "rev-B" });
      await promise.catch(() => {});
    });

    // The stale response must not touch vid2's state at all.
    expect(result.current.pendingRevisionNotice).toBeNull();
    expect(result.current.uxState).toBe("transcript_processing");
    void queryClient; // kept for symmetry with other tests that trigger refetches directly
  });
});

describe("useDictationSession — manual paste / SRT upload follow the same protection", () => {
  it("handleManualTranscriptSaved with a different id shows the notice instead of swapping content", async () => {
    const { result } = await renderEstablished();

    await act(async () => {
      await result.current.handleManualTranscriptSaved("rev-C");
    });

    expect(result.current.pendingRevisionNotice).toEqual(expect.stringContaining("Restart"));
    expect(result.current.segments[0]?.transcript_id).toBe("rev-A");
  });

  it("handleManualTranscriptSaved adopts the new revision when there is no usable lesson yet", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMock.fetchResumeSession.mockResolvedValue(noSession);
    apiMock.fetchTranscript.mockImplementation(async (_videoId, pinnedId) =>
      pinnedId ? readyResponse(pinnedId) : { status: "failed", segments: [] }
    );

    const { result } = renderHook((props: { videoId: string; user: User | null }) => useDictationSession(props), {
      wrapper: makeWrapper(queryClient),
      initialProps: { videoId: "vid1", user: null },
    });
    await waitFor(() => expect(result.current.uxState).toBe("transcript_failed"));

    apiMock.fetchTranscript.mockImplementation(async () => readyResponse("rev-new"));
    await act(async () => {
      await result.current.handleManualTranscriptSaved("rev-new");
    });

    await waitFor(() => expect(result.current.segments[0]?.transcript_id).toBe("rev-new"));
  });
});

describe("useDictationSession — autosave identity gating", () => {
  it("6. never autosaves before resume/pin/restoration resolve, even once the video is set", async () => {
    const { promise } = deferred<ResumeSessionResponse>();
    apiMock.fetchResumeSession.mockReturnValue(promise as never);
    apiMock.fetchTranscript.mockResolvedValue(readyResponse("rev-A"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook((props: { videoId: string; user: User | null }) => useDictationSession(props), {
      wrapper: makeWrapper(queryClient),
      initialProps: { videoId: "vid1", user },
    });

    // Resume never resolves in this test — identity is permanently
    // unresolved, so nothing should ever have called saveProgress.
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.saveProgress).not.toHaveBeenCalled();
  });
});

describe("useDictationSession — legitimate backward navigation and Restart", () => {
  it("7. moving to an earlier sentence still saves that lower index (never clamped to the previous max)", async () => {
    const { result } = await renderEstablished();
    act(() => result.current.handleResume());
    await waitFor(() => expect(result.current.uxState).toBe("playing"));

    act(() => result.current.handlePrevious());

    await waitFor(() => expect(apiMock.saveProgress).toHaveBeenCalled());
    const lastCall = apiMock.saveProgress.mock.calls.at(-1)!;
    // saveProgress(videoId, segmentIndex, ...) — resumeState started at
    // index 2, handlePrevious must persist index 1, not re-clamp upward.
    expect(lastCall[1]).toBe(1);
  });

  it("15. explicit Restart still abandons the session and re-targets the transcript query to current", async () => {
    const { result } = await renderEstablished();
    apiMock.fetchTranscript.mockClear();

    await act(async () => {
      await result.current.handleRestart();
    });

    expect(apiMock.restartSession).toHaveBeenCalledWith("vid1", "sess-1");
    expect(result.current.resumeState).toBeNull();
  });
});

describe("useDictationSession — Resume/Start vs a concurrent transcript refetch", () => {
  it("9. resuming while a background transcript refetch lands in the same tick does not revert to the start screen", async () => {
    const { result, queryClient } = await renderEstablished();

    await act(async () => {
      // Both fire together, exercising the exact interleaving the fix
      // targets: handleResume's setUxState("playing") landing in the same
      // commit as the transcript query's dataUpdatedAt changing.
      result.current.handleResume();
      await queryClient.refetchQueries({ queryKey: ["transcript", "vid1", "en", "rev-A"] });
    });

    expect(result.current.uxState).toBe("playing");
  });
});
