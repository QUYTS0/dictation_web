/**
 * Tests YouTubePlayer.tsx's player-instance ownership guard — the fix for
 * the focused Phase 0 bug fix's reported playback-time oscillation. Two
 * concrete defects were found and fixed in the component:
 *
 *  1. initPlayer() never called stopTick(), and the outer effect only
 *     registered a cleanup function on the "API script still loading"
 *     branch — so on the common "API already loaded" path, switching
 *     players left the previous instance's polling interval running
 *     indefinitely, feeding stale/erratic times into the shared store
 *     alongside the new instance's own tick.
 *  2. Nothing stopped a trailing event from an already-superseded instance
 *     (e.g. a late onReady/onStateChange) from writing into the shared
 *     store as if it belonged to the current one.
 *
 * A minimal fake `window.YT.Player` stands in for the real YouTube IFrame
 * API — these tests only need to verify which instance's events are allowed
 * to reach the store, not real YouTube network/embed behavior.
 */
import { act, render } from "@testing-library/react";
import { createRef } from "react";
import YouTubePlayer, { type YouTubePlayerHandle } from "@/components/YouTubePlayer";
import { usePlayerStore } from "@/store/playerStore";
import type { TranscriptSegment } from "@/lib/types";

class FakeYTPlayer {
  static instances: FakeYTPlayer[] = [];
  destroyed = false;
  time = 0;
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
    if (this.destroyed) throw new Error("getCurrentTime called on a destroyed/superseded player instance");
    return this.time;
  }
  seekTo() {}
  playVideo() {}
  pauseVideo() {}
  setPlaybackRate() {}
  destroy() {
    this.destroyed = true;
  }
  fireReady() {
    this.events.onReady({ target: this });
  }
  fireStateChange(data: number) {
    this.events.onStateChange({ data });
  }
}

const PLAYER_STATE = { PLAYING: 1, PAUSED: 2, ENDED: 0 };

beforeEach(() => {
  FakeYTPlayer.instances = [];
  window.YT = { Player: FakeYTPlayer, PlayerState: PLAYER_STATE };
  usePlayerStore.getState().reset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

const noopSegments: TranscriptSegment[] = [];

describe("YouTubePlayer — instance ownership", () => {
  it("11. a new instance resets stale playback state left by whatever owned the store before it", () => {
    // Simulate a value left over from a previous video/session (e.g. the
    // audit's finding that playerStore was never reset between visits).
    usePlayerStore.setState({ currentTimeSec: 85, status: "playing" });

    const ref = createRef<YouTubePlayerHandle>();
    render(<YouTubePlayer ref={ref} videoId="v1" segments={noopSegments} onSegmentEnd={jest.fn()} />);

    // Ownership boundary (initPlayer, before the new instance is even
    // ready) already clears it — nothing stale is ever shown as if it
    // belonged to the new instance.
    expect(usePlayerStore.getState().currentTimeSec).toBe(0);
    expect(usePlayerStore.getState().status).not.toBe("playing");
  });

  it("11. switching instances stops polling the old one — its getCurrentTime is never called again", () => {
    const ref = createRef<YouTubePlayerHandle>();
    const { rerender } = render(<YouTubePlayer ref={ref} videoId="v1" segments={noopSegments} onSegmentEnd={jest.fn()} />);
    const instance1 = FakeYTPlayer.instances[0];
    act(() => instance1.fireReady());
    act(() => instance1.fireStateChange(PLAYER_STATE.PLAYING));

    // Switch to a new video — this destroys instance1 and creates
    // instance2. If the old tick were still running (the pre-fix bug),
    // its next fire would call instance1.getCurrentTime(), which throws
    // once destroyed — advancing fake timers here would surface that.
    rerender(<YouTubePlayer ref={ref} videoId="v2" segments={noopSegments} onSegmentEnd={jest.fn()} />);
    expect(() => act(() => jest.advanceTimersByTime(1000))).not.toThrow();
  });

  it("11. a trailing event from a superseded instance cannot write into the shared store", () => {
    const ref = createRef<YouTubePlayerHandle>();
    const { rerender } = render(<YouTubePlayer ref={ref} videoId="v1" segments={noopSegments} onSegmentEnd={jest.fn()} />);
    const instance1 = FakeYTPlayer.instances[0];

    rerender(<YouTubePlayer ref={ref} videoId="v2" segments={noopSegments} onSegmentEnd={jest.fn()} />);
    const instance2 = FakeYTPlayer.instances[1];
    act(() => instance2.fireReady());
    expect(usePlayerStore.getState().durationSec).toBe(600); // instance2's own onReady applied

    // A late callback from instance1 (its destroy() doesn't guarantee the
    // IFrame API can never fire a trailing event) must be ignored — the
    // ownership token no longer matches.
    instance1.destroyed = false; // bypass the getCurrentTime guard for this direct event-fire check
    act(() => instance1.fireStateChange(PLAYER_STATE.PLAYING));
    expect(usePlayerStore.getState().status).not.toBe("playing");
  });

  it("12. current-time only ever reflects the active instance's own reported time, never a stale one", () => {
    const ref = createRef<YouTubePlayerHandle>();
    const { rerender } = render(<YouTubePlayer ref={ref} videoId="v1" segments={noopSegments} onSegmentEnd={jest.fn()} />);
    const instance1 = FakeYTPlayer.instances[0];
    instance1.time = 5;
    act(() => instance1.fireReady());
    act(() => instance1.fireStateChange(PLAYER_STATE.PLAYING));
    act(() => jest.advanceTimersByTime(200));
    expect(usePlayerStore.getState().currentTimeSec).toBe(5);

    rerender(<YouTubePlayer ref={ref} videoId="v2" segments={noopSegments} onSegmentEnd={jest.fn()} />);
    const instance2 = FakeYTPlayer.instances[1];
    instance2.time = 50;
    act(() => instance2.fireReady());
    act(() => instance2.fireStateChange(PLAYER_STATE.PLAYING));
    act(() => jest.advanceTimersByTime(200));

    // Only instance2's value is ever visible — no oscillation back to
    // instance1's last reported time.
    expect(usePlayerStore.getState().currentTimeSec).toBe(50);
  });
});
