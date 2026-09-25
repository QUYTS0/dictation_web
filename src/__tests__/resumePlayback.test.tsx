/**
 * Post-Phase-2 repair: first Play/Space after reopening a lesson must start
 * at the resolved resume target, not at 0:00 — and initialization must never
 * overwrite the saved checkpoint.
 *
 * Wires the REAL useDictationSession + REAL YouTubePlayer + REAL
 * useKeyboardShortcuts together the way page.tsx does (the Play/Pause toggle
 * below is a copy of page.tsx's 5-line handleTogglePlayback). Only the
 * YouTube IFrame API itself is faked, plus the network layer (api.ts).
 *
 * The fake player models the behavior behind the reported symptom: a
 * seekTo() issued on a video that has never played, outside a user gesture
 * (e.g. from onReady or a restore effect), does not reliably position it —
 * the IFrame API documents that seekTo() on a cued video starts playback,
 * which browsers' autoplay policy blocks without user activation — so the
 * fake simply drops such a seek. Seeks issued inside a user gesture (the
 * `press()` helper) behave normally, matching the user's report that Replay
 * (seek-then-play in one click) always worked. This is a MOCKED player:
 * passing here is not real-browser verification.
 */
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import type { User } from "@supabase/supabase-js";
import YouTubePlayer from "@/components/YouTubePlayer";
import { useDictationSession } from "@/app/dictation/[videoId]/useDictationSession";
import { useKeyboardShortcuts } from "@/app/dictation/[videoId]/useKeyboardShortcuts";
import { usePlayerStore } from "@/store/playerStore";
import { useSessionStore } from "@/store/sessionStore";
import type { ResumeSessionResponse, TranscriptResponse, TranscriptSegment } from "@/lib/types";

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

// ---- Fake IFrame API ----------------------------------------------------
let userGesture = false;
const PLAYER_STATE = { PLAYING: 1, PAUSED: 2, ENDED: 0 };

class FakeYTPlayer {
  static instances: FakeYTPlayer[] = [];
  time = 0;
  started = false;
  destroyed = false;
  droppedSeeks: number[] = [];
  log: Array<[string, number?]> = [];
  timeAtFirstPlay: number | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: any;
  constructor(_el: unknown, config: { events: unknown }) {
    this.events = config.events;
    FakeYTPlayer.instances.push(this);
  }
  getDuration() {
    return 600;
  }
  getCurrentTime() {
    return this.time;
  }
  seekTo(t: number) {
    this.log.push(["seekTo", t]);
    if (!this.started && !userGesture) {
      this.droppedSeeks.push(t);
      return;
    }
    this.time = t;
  }
  playVideo() {
    this.log.push(["playVideo"]);
    if (!this.started) this.timeAtFirstPlay = this.time;
    this.started = true;
    this.events.onStateChange({ data: PLAYER_STATE.PLAYING });
  }
  pauseVideo() {
    this.log.push(["pauseVideo"]);
    this.events.onStateChange({ data: PLAYER_STATE.PAUSED });
  }
  setPlaybackRate() {}
  destroy() {
    this.destroyed = true;
  }
  fireReady() {
    this.events.onReady({ target: this });
  }
}
const current = () => FakeYTPlayer.instances.at(-1)!;

/** Runs a user interaction with "user activation" in effect. */
function press(fn: () => void) {
  userGesture = true;
  try {
    act(fn);
  } finally {
    userGesture = false;
  }
}

// ---- Fixtures -------------------------------------------------------------
// Sentence i spans [2i, 2i+2). Sentence index 2 → [4, 6).
function makeSegments(transcriptId: string, count = 6): TranscriptSegment[] {
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
const ready = (id: string): TranscriptResponse => ({ status: "ready", segments: makeSegments(id), transcriptId: id });
function resumeAt(segIdx: number, timeSec: number, transcriptId = "rev-A"): ResumeSessionResponse {
  return {
    session: {
      sessionId: "sess-1",
      currentSegmentIndex: segIdx,
      videoCurrentTimeSec: timeSec,
      accuracy: 100,
      totalAttempts: 1,
      updatedAt: new Date().toISOString(),
      status: "active",
      transcriptId,
    },
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const userA = { id: "user-A" } as User;
const userB = { id: "user-B" } as User;

// ---- Harness mirroring page.tsx wiring -----------------------------------
type Session = ReturnType<typeof useDictationSession>;
let latest: Session;
function captureSession(s: Session) {
  latest = s;
}

function Harness({ videoId, user, mode }: { videoId: string; user: User | null; mode: "listening" | "shadowing" | "dictation" }) {
  const session = useDictationSession({ videoId, user, autoEnterPaused: mode !== "dictation" });
  // Exposes the latest committed hook value to the test body.
  useEffect(() => captureSession(session));
  // Destructured the same way page.tsx consumes the hook.
  const {
    ytPlayerRef,
    segments,
    handleSegmentEnd,
    handlePlayerReady,
    handleActiveSegmentChange,
    handleReplay,
    handlePrevious,
    handleSkip,
  } = session;
  // Same as page.tsx's handleTogglePlayback.
  const handleTogglePlayback = useCallback(() => {
    if (usePlayerStore.getState().status === "playing") {
      ytPlayerRef.current?.pauseVideo();
    } else {
      ytPlayerRef.current?.playVideo();
    }
  }, [ytPlayerRef]);
  useKeyboardShortcuts({
    onReplay: handleReplay,
    onPrevious: handlePrevious,
    onSkip: handleSkip,
    onTogglePlayback: handleTogglePlayback,
    isListeningMode: mode !== "dictation",
    isZenMode: false,
    onZenModeChange: () => {},
  });
  return (
    <>
      {/* Always mounted here (page.tsx mounts it once the transcript is
          ready) so tests can also drive "player ready BEFORE resume data". */}
      <YouTubePlayer
        ref={ytPlayerRef}
        videoId={videoId}
        segments={segments}
        onSegmentEnd={handleSegmentEnd}
        onReady={handlePlayerReady}
        continuous={mode === "listening"}
        onActiveSegmentChange={handleActiveSegmentChange}
      />
      <button onClick={handleTogglePlayback}>Play</button>
      <button onClick={handleReplay}>Replay</button>
      <input aria-label="answer" />
    </>
  );
}

function renderHarness(props: { videoId: string; user: User | null; mode: "listening" | "shadowing" | "dictation" }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>
  );
  const rerender = (next: typeof props) =>
    utils.rerender(
      <QueryClientProvider client={queryClient}>
        <Harness {...next} />
      </QueryClientProvider>
    );
  return { ...utils, rerender, queryClient };
}

async function waitRestored(segIdx: number) {
  await waitFor(() => expect(latest.uxState).toBe("paused_waiting_input"));
  await waitFor(() => expect(latest.currentSegIdx).toBe(segIdx));
}

beforeEach(() => {
  jest.clearAllMocks();
  FakeYTPlayer.instances = [];
  window.YT = { Player: FakeYTPlayer, PlayerState: PLAYER_STATE };
  usePlayerStore.getState().reset();
  useSessionStore.getState().reset();
  window.sessionStorage.clear();
  apiMock.saveProgress.mockResolvedValue({ sessionId: "sess-1" });
  apiMock.restartSession.mockResolvedValue(undefined);
  apiMock.requestTranscriptGeneration.mockResolvedValue({ status: "processing" });
  apiMock.fetchTranscript.mockImplementation(async (_v, pinned) => ready(pinned ?? "rev-A"));
});

// -------------------------------------------------------------------------
describe("first Play / Space after reopening a lesson", () => {
  it("resume target resolved BEFORE player readiness → first Play starts at the target", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    const { getByText } = renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    await waitRestored(2);

    act(() => current().fireReady());
    press(() => fireEvent.click(getByText("Play")));

    expect(current().timeAtFirstPlay).toBe(4.5);
    expect(current().droppedSeeks).toEqual([]); // nothing seeked the cued video outside a gesture
  });

  it("player readiness BEFORE resume data → same outcome", async () => {
    const resume = deferred<ResumeSessionResponse>();
    apiMock.fetchResumeSession.mockReturnValue(resume.promise as never);
    const { getByText } = renderHarness({ videoId: "vid1", user: userA, mode: "listening" });

    act(() => current().fireReady()); // ready first
    await act(async () => {
      resume.resolve(resumeAt(2, 4.5));
      await resume.promise;
    });
    await waitRestored(2);

    press(() => fireEvent.click(getByText("Play")));
    expect(current().timeAtFirstPlay).toBe(4.5);
  });

  it("first action is Space → same as Play (Listening and Shadowing)", async () => {
    for (const mode of ["listening", "shadowing"] as const) {
      FakeYTPlayer.instances = [];
      apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
      const { unmount } = renderHarness({ videoId: `vid-${mode}`, user: userA, mode });
      await waitRestored(2);
      act(() => current().fireReady());

      press(() => fireEvent.keyDown(window, { code: "Space", key: " " }));

      expect(current().timeAtFirstPlay).toBe(4.5);
      unmount();
    }
  });

  it("Shadowing (per-sentence mode): first Play does not auto-pause against sentence 1's end", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    const { getByText } = renderHarness({ videoId: "vid1", user: userA, mode: "shadowing" });
    await waitRestored(2);
    act(() => current().fireReady());
    press(() => fireEvent.click(getByText("Play")));

    // Let the 200ms playback tick run once at a time inside sentence 3 (idx 2).
    current().time = 4.8;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 260));
    });
    expect(current().log.filter(([c]) => c === "pauseVideo")).toHaveLength(0);
    expect(latest.currentSegIdx).toBe(2);
  });

  it("falls back to the selected sentence's start when the saved time doesn't belong to it (e.g. a 0:00 row)", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 0));
    const { getByText } = renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    await waitRestored(2);
    act(() => current().fireReady());
    press(() => fireEvent.click(getByText("Play")));
    expect(current().timeAtFirstPlay).toBeCloseTo(3.8); // sentence start 4 minus the 0.2s pre-roll
  });

  it("first action is Replay → starts at the selected sentence's beginning", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 5.1));
    const { getByText } = renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    await waitRestored(2);
    act(() => current().fireReady());

    press(() => fireEvent.click(getByText("Replay")));
    expect(current().timeAtFirstPlay).toBeCloseTo(3.8);
  });

  it("Shift+Space replays only — it never also toggles playback", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 5.1));
    renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    await waitRestored(2);
    act(() => current().fireReady());

    press(() => fireEvent.keyDown(window, { code: "Space", key: " ", shiftKey: true }));
    expect(current().timeAtFirstPlay).toBeCloseTo(3.8);
    expect(current().log.filter(([c]) => c === "playVideo")).toHaveLength(1);
    expect(current().log.filter(([c]) => c === "pauseVideo")).toHaveLength(0);
  });

  it("Space inside a text field keeps typing behavior and does not start playback; held Space doesn't repeat", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    const { getByLabelText } = renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    await waitRestored(2);
    act(() => current().fireReady());

    press(() => fireEvent.keyDown(getByLabelText("answer"), { code: "Space", key: " " }));
    expect(current().started).toBe(false);

    press(() => fireEvent.keyDown(window, { code: "Space", key: " " }));
    press(() => fireEvent.keyDown(window, { code: "Space", key: " ", repeat: true }));
    expect(current().log.filter(([c]) => c === "seekTo")).toHaveLength(1);
    expect(current().started).toBe(true);
  });

  it("Pause midway, then Play → continues from the paused playhead (no seek back to the sentence start)", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    const { getByText } = renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    await waitRestored(2);
    act(() => current().fireReady());

    press(() => fireEvent.click(getByText("Play")));
    current().time = 7.3; // played on into sentence 4
    press(() => fireEvent.click(getByText("Play"))); // pauses
    const seeksBefore = current().log.filter(([c]) => c === "seekTo").length;
    press(() => fireEvent.click(getByText("Play"))); // resumes

    expect(current().log.filter(([c]) => c === "seekTo").length).toBe(seeksBefore);
    expect(current().time).toBe(7.3);
  });
});

// -------------------------------------------------------------------------
describe("stale restores never override newer context or user intent", () => {
  it("resume pending, then switching video → the old target is ignored by the new video's player", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    const { getByText, rerender } = renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    await waitRestored(2);

    apiMock.fetchResumeSession.mockResolvedValue({ session: null });
    rerender({ videoId: "vid2", user: userA, mode: "listening" });
    await waitFor(() => expect(latest.currentSegIdx).toBe(0));
    await waitFor(() => expect(latest.uxState).toBe("paused_waiting_input"));
    act(() => current().fireReady());
    press(() => fireEvent.click(getByText("Play")));

    expect(current().timeAtFirstPlay).toBe(0);
    expect(current().log.some(([c, t]) => c === "seekTo" && t === 4.5)).toBe(false);
  });

  it("resume in flight for user A, then user B signs in → A's late response is ignored", async () => {
    const resumeA = deferred<ResumeSessionResponse>();
    apiMock.fetchResumeSession.mockReturnValueOnce(resumeA.promise as never).mockResolvedValue({ session: null });
    const { getByText, rerender } = renderHarness({ videoId: "vid1", user: userA, mode: "listening" });

    rerender({ videoId: "vid1", user: userB, mode: "listening" });
    await act(async () => {
      resumeA.resolve(resumeAt(4, 8.5));
      await resumeA.promise;
    });
    await waitFor(() => expect(latest.uxState).toBe("paused_waiting_input"));
    act(() => current().fireReady());
    press(() => fireEvent.click(getByText("Play")));

    expect(latest.currentSegIdx).toBe(0);
    expect(current().timeAtFirstPlay).toBe(0);
  });

  it("user picks another sentence while the player is still loading → the user's choice wins on first Play", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    const { getByText } = renderHarness({ videoId: "vid1", user: userA, mode: "shadowing" });
    await waitRestored(2);

    act(() => latest.jumpToSegment(4)); // player not ready yet — nothing can play
    act(() => current().fireReady()); // must not re-arm the superseded 4.5 target
    press(() => fireEvent.click(getByText("Play")));

    expect(current().timeAtFirstPlay).toBeCloseTo(7.8); // sentence 5 start (8) minus pre-roll
    expect(latest.currentSegIdx).toBe(4);
  });

  it("a restore that lands after the user already started playback does not move the playhead", async () => {
    const resume = deferred<ResumeSessionResponse>();
    apiMock.fetchResumeSession.mockReturnValue(resume.promise as never);
    const { getByText } = renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    act(() => current().fireReady());
    press(() => fireEvent.click(getByText("Play"))); // user plays before resume data exists
    current().time = 1.4;

    await act(async () => {
      resume.resolve(resumeAt(2, 4.5));
      await resume.promise;
    });
    await waitFor(() => expect(latest.uxState).toBe("paused_waiting_input"));

    expect(current().time).toBe(1.4);
    expect(current().log.filter(([c]) => c === "seekTo")).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------
describe("initialization never overwrites the saved checkpoint", () => {
  it("reopen, do not play, then leave (tab hidden + pagehide) → re-saves the restored checkpoint, never 0:00", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    await waitRestored(2);
    act(() => current().fireReady());

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

    expect(apiMock.saveProgress).toHaveBeenCalled();
    for (const call of apiMock.saveProgress.mock.calls) {
      expect(call[1]).toBe(2); // segment index
      expect(call[2]).toBe(4.5); // playhead — the checkpoint, not the player's 0:00 default
    }
  });

  it("the sessionStorage snapshot keeps the checkpoint time too (not the player's 0:00)", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    await waitRestored(2);
    await waitFor(() => expect(window.sessionStorage.getItem("dictation.active-session.vid1")).not.toBeNull());
    const snap = JSON.parse(window.sessionStorage.getItem("dictation.active-session.vid1")!);
    expect(snap.currentSegIdx).toBe(2);
    expect(snap.videoCurrentTimeSec).toBe(4.5);
  });

  it("resume check FAILED → opening never creates/overwrites the checkpoint with sentence 1 / 0:00", async () => {
    apiMock.fetchResumeSession.mockRejectedValue(new Error("network down"));
    renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    await waitFor(() => expect(latest.uxState).toBe("paused_waiting_input"));

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

    expect(apiMock.saveProgress).not.toHaveBeenCalled();
  });

  it("after restoring, deliberate backward navigation still saves the lower sentence (and its own start time)", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    renderHarness({ videoId: "vid1", user: userA, mode: "shadowing" });
    await waitRestored(2);
    act(() => current().fireReady());

    press(() => latest.handlePrevious());

    const last = apiMock.saveProgress.mock.calls.at(-1)!;
    expect(last[1]).toBe(1);
    expect(last[2]).toBeCloseTo(1.8);
  });

  it("after restoring, deliberately restarting at sentence 1 still saves index 0", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    renderHarness({ videoId: "vid1", user: userA, mode: "shadowing" });
    await waitRestored(2);
    act(() => current().fireReady());

    press(() => latest.jumpToSegment(0));
    const last = apiMock.saveProgress.mock.calls.at(-1)!;
    expect(last[1]).toBe(0);
    expect(last[2]).toBe(0);
  });

  it("regenerating while restored keeps the pinned revision, selected sentence and resume target", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    apiMock.regenerateTranscript.mockResolvedValue({ status: "ready", transcriptId: "rev-B" });
    const { getByText } = renderHarness({ videoId: "vid1", user: userA, mode: "listening" });
    await waitRestored(2);

    await act(async () => {
      await latest.handleRegenerateTranscript();
    });
    expect(latest.pendingRevisionNotice).toEqual(expect.stringContaining("Restart"));
    expect(latest.segments[0]?.transcript_id).toBe("rev-A");
    expect(latest.currentSegIdx).toBe(2);
    expect(apiMock.saveProgress).not.toHaveBeenCalled();

    act(() => current().fireReady());
    press(() => fireEvent.click(getByText("Play")));
    expect(current().timeAtFirstPlay).toBe(4.5);
  });
});

// -------------------------------------------------------------------------
describe("Dictation's explicit Resume button", () => {
  it("plays the checkpoint sentence from the resolved target in one seek-then-play", async () => {
    apiMock.fetchResumeSession.mockResolvedValue(resumeAt(2, 4.5));
    renderHarness({ videoId: "vid1", user: userA, mode: "dictation" });
    await waitFor(() => expect(latest.uxState).toBe("transcript_ready"));
    act(() => current().fireReady());

    press(() => latest.handleResume());
    expect(current().timeAtFirstPlay).toBe(4.5);
    expect(current().log.filter(([c]) => c === "seekTo")).toEqual([["seekTo", 4.5]]);
  });
});
