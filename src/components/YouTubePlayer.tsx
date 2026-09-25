"use client";

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { usePlayerStore } from "@/store/playerStore";
import { findSegmentIndexAtTime } from "@/lib/utils/segment";
import { SEGMENT_START_PRE_ROLL_SEC } from "@/lib/utils/resumeTarget";
import type { TranscriptSegment } from "@/lib/types";

/** Where this player instance's FIRST playback should start — see
 *  setStartTarget below. */
export interface PlayerStartTarget {
  segmentIndex: number;
  timeSec: number;
}

export interface YouTubePlayerHandle {
  /** Seeks to the segment's start (or to `fromSec`, when given) and plays —
   *  an explicit navigation, so it also discards any armed start target. */
  playSegment: (segIdx: number, fromSec?: number) => void;
  /** Plays from the live playhead. The first call on an instance that has
   *  never played honors an armed start target instead of starting at 0. */
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (timeSec: number, autoPlay?: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  /** Arms (or with null, clears) the position the instance's first playback
   *  starts from. Deliberately does NOT seek the cued player: the IFrame
   *  API documents that seekTo() on a cued video starts playback, and a
   *  seek issued outside a user gesture on a never-played video is not a
   *  reliable way to position it. The seek happens inside the first
   *  playVideo() call instead (the same seek-then-play pattern Replay
   *  uses). Ignored once the instance has started playing — a restore that
   *  arrives after real playback must never move the user's playhead.
   *  Returns whether the target was accepted. */
  setStartTarget: (target: PlayerStartTarget | null) => boolean;
  /** The real player's playhead, or null while this instance has never
   *  played — before first playback the player sits at an initialization
   *  default (0:00), which is not a position anyone chose and must never be
   *  persisted as progress. */
  getLivePlayheadSec: () => number | null;
}

interface YouTubePlayerProps {
  videoId: string;
  segments: TranscriptSegment[];
  /** Called when the player pauses at the end of a segment */
  onSegmentEnd: (segmentIndex: number) => void;
  /** Called once the underlying YouTube player is ready to accept commands */
  onReady?: () => void;
  /** Listening Mode: play straight through sentence boundaries instead of
   *  auto-pausing at the end of each segment. */
  continuous?: boolean;
  /** Continuous mode only — fires whenever playback crosses into a different
   *  segment's time range, so the page can keep the active sentence in sync. */
  onActiveSegmentChange?: (segmentIndex: number) => void;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

/** Unloads YouTube's native caption module (undocumented but long-stable
 *  IFrame API method) — the only reliable way to keep captions off when the
 *  viewer's YouTube account has "always show captions" enabled. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hideNativeCaptions(player: any) {
  try {
    player.unloadModule?.("captions");
    player.unloadModule?.("cc");
  } catch {
    // Module not loaded (yet) — nothing to hide.
  }
}

const YouTubePlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(
  function YouTubePlayer({ videoId, segments, onSegmentEnd, onReady, continuous = false, onActiveSegmentChange }, ref) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const playerRef = useRef<any>(null);
    const playerReadyRef = useRef<boolean>(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const activeSegmentIdxRef = useRef<number>(0);
    const isPausedRef = useRef<boolean>(false);
    const playbackRateRef = useRef<number>(1);
    // Ownership token: bumped every time initPlayer() creates a new
    // underlying YT.Player. Every callback that writes to the shared
    // playerStore (tick, onReady, onStateChange) closes over the token
    // value at the moment IT was registered and checks it against
    // instanceIdRef.current before writing — so a late event/interval tick
    // from a destroyed instance (e.g. a trailing callback that fires during
    // teardown, or an overlapping create/destroy under React Strict Mode)
    // can never overwrite state that belongs to a newer, current instance.
    const instanceIdRef = useRef(0);
    // Continuous mode only: set by playSegmentFn to the segment a manual
    // Replay/Next/Previous navigated to. playSegmentFn seeks to a small
    // pre-roll point *before* that segment's start (see
    // SEGMENT_START_PRE_ROLL_SEC), which falls inside the *previous*
    // segment's [start, end) range for back-to-back segments. Until playback
    // actually reaches the target's real start, the time-derived lookup
    // below would otherwise report the previous segment and briefly bounce
    // the active sentence backward before snapping forward again. This ref
    // tells the tick to hold the manually-set index instead of trusting that
    // stale/pre-roll time-derived reading.
    const pendingManualTargetRef = useRef<number | null>(null);
    // Per-instance: whether this player has ever reached PLAYING, and the
    // armed start target its first playVideo() honors (see setStartTarget).
    // Both reset whenever initPlayer() creates a new instance, so a target
    // armed for a previous video/instance can never leak into a new one.
    const hasStartedPlaybackRef = useRef(false);
    const startTargetRef = useRef<PlayerStartTarget | null>(null);

    const setStatus = usePlayerStore((s) => s.setStatus);
    const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
    const setDuration = usePlayerStore((s) => s.setDuration);
    const setCurrentSegmentIndex = usePlayerStore((s) => s.setCurrentSegmentIndex);
    const resetPlayback = usePlayerStore((s) => s.resetPlayback);

    // Keep segments accessible in the tick callback without re-creating it
    const segmentsRef = useRef(segments);
    useEffect(() => {
      segmentsRef.current = segments;
    }, [segments]);

    const onSegmentEndRef = useRef(onSegmentEnd);
    useEffect(() => {
      onSegmentEndRef.current = onSegmentEnd;
    }, [onSegmentEnd]);

    const onReadyRef = useRef(onReady);
    useEffect(() => {
      onReadyRef.current = onReady;
    }, [onReady]);

    const continuousRef = useRef(continuous);
    useEffect(() => {
      continuousRef.current = continuous;
    }, [continuous]);

    const onActiveSegmentChangeRef = useRef(onActiveSegmentChange);
    useEffect(() => {
      onActiveSegmentChangeRef.current = onActiveSegmentChange;
    }, [onActiveSegmentChange]);

    const startTick = useCallback((ownerInstanceId: number) => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = setInterval(() => {
        // This instance was superseded (a newer player was created) since
        // this interval was started — stop writing to the shared store.
        // The interval itself is cleared by whichever code superseded us
        // (stopTick()/destroy()), but this guard closes the small window
        // where a tick already queued on the event loop fires before that
        // cleanup runs.
        if (instanceIdRef.current !== ownerInstanceId) return;
        const player = playerRef.current;
        if (!player) return;
        const time = player.getCurrentTime?.() ?? 0;
        setCurrentTime(time);

        const segs = segmentsRef.current;
        if (!segs.length) return;

        // Listening Mode: play straight through — just track which segment the
        // playhead is currently inside so the active sentence stays in sync,
        // never auto-pause.
        if (continuousRef.current) {
          const pendingTarget = pendingManualTargetRef.current;
          if (pendingTarget !== null) {
            const targetSeg = segs[pendingTarget];
            if (targetSeg && time < targetSeg.start) {
              // Still inside the pre-roll before the manually navigated
              // segment's real start — hold, don't let the time-derived
              // lookup below bounce the active sentence back to the
              // previous one.
              return;
            }
            pendingManualTargetRef.current = null;
          }

          const idx = findSegmentIndexAtTime(segs, time);
          if (idx !== -1 && idx !== activeSegmentIdxRef.current) {
            activeSegmentIdxRef.current = idx;
            setCurrentSegmentIndex(idx);
            onActiveSegmentChangeRef.current?.(idx);
          }
          return;
        }

        const idx = activeSegmentIdxRef.current;
        const seg = segs[idx];
        if (!seg) return;

        // Auto-pause when we reach the end of the active segment. Parked position
        // matches SEGMENT_START_PRE_ROLL_SEC (not a smaller offset) so that when the
        // next segment starts — which begins exactly where this one ends — playSegment
        // doesn't need a small backward seek to reach its pre-roll point. Tiny backward
        // seeks near the current position are unreliable in YouTube's IFrame API (no
        // buffering state change fires, so playVideo() can silently resume from the old
        // position instead), which was clipping the next segment's first word on auto-advance.
        if (time >= seg.end && !isPausedRef.current) {
          isPausedRef.current = true;
          player.pauseVideo();
          player.seekTo(Math.max(0, seg.end - SEGMENT_START_PRE_ROLL_SEC), true);
          setCurrentSegmentIndex(idx);
          onSegmentEndRef.current(idx);
        }
      }, 200);
    }, [setCurrentTime, setCurrentSegmentIndex]);

    const stopTick = useCallback(() => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    }, []);

    const initPlayer = useCallback(() => {
      if (!containerRef.current) return;
      // Stop any interval left running from a previous instance before
      // creating a new one — this must happen here (not only in the
      // effect's cleanup below), since the "API already loaded" path calls
      // initPlayer() directly on every videoId change without the effect
      // ever unmounting/cleaning up in between. Leaving the old interval
      // running would poll a `playerRef.current` that's about to be
      // reassigned to the new player, feeding stale/erratic times into the
      // shared store alongside the new instance's own tick.
      stopTick();
      if (playerRef.current) {
        playerRef.current.destroy();
      }
      playerReadyRef.current = false;
      hasStartedPlaybackRef.current = false;
      startTargetRef.current = null;
      // This instance is now the sole owner of the shared player store —
      // mint a fresh token (invalidating any callback still in flight from
      // whatever instance owned it before, even if destroy() above doesn't
      // fully suppress a trailing event) and clear any time/status/duration
      // that instance left behind, so nothing stale is ever briefly shown
      // as if it belonged to this one.
      const myInstanceId = ++instanceIdRef.current;
      resetPlayback();

      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          rel: 0,
          modestbranding: 1,
          // cc_load_policy can only force captions ON (1); 0/unset defers to the
          // viewer's own YouTube "always show captions" preference. We show our
          // own script/transcript UI instead, so native captions are actually
          // suppressed via hideNativeCaptions() in onReady/onStateChange.
          cc_load_policy: 0,
          iv_load_policy: 3,
        },
        events: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onReady: (event: any) => {
            if (instanceIdRef.current !== myInstanceId) return;
            hideNativeCaptions(event.target);
            playerReadyRef.current = true;
            setStatus("ready");
            setDuration(event.target.getDuration());
            event.target.setPlaybackRate(playbackRateRef.current);
            console.log("[YouTubePlayer] player ready, videoId=", videoId);
            onReadyRef.current?.();
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onStateChange: (event: any) => {
            if (instanceIdRef.current !== myInstanceId) return;
            if (event.data === window.YT.PlayerState.PLAYING) {
              // The captions module loads lazily on first play, so an unload
              // in onReady alone isn't enough.
              hideNativeCaptions(event.target);
              hasStartedPlaybackRef.current = true;
              startTargetRef.current = null;
              setStatus("playing");
              isPausedRef.current = false;
              startTick(myInstanceId);
            } else if (event.data === window.YT.PlayerState.PAUSED) {
              setStatus("paused");
              stopTick();
            } else if (event.data === window.YT.PlayerState.ENDED) {
              setStatus("ended");
              stopTick();
            }
          },
        },
      });
    }, [videoId, setStatus, setDuration, startTick, stopTick, resetPlayback]);

    // Load the YouTube IFrame API script once
    useEffect(() => {
      if (typeof window === "undefined") return;

      setStatus("loading");

      if (window.YT && window.YT.Player) {
        initPlayer();
      } else {
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        const firstScript = document.getElementsByTagName("script")[0];
        firstScript?.parentNode?.insertBefore(tag, firstScript);

        window.onYouTubeIframeAPIReady = () => {
          initPlayer();
        };
      }

      // Registered unconditionally (previously only on the "script still
      // loading" branch above) — the "API already loaded" branch used to
      // return early with no cleanup at all, so nothing ever called
      // stopTick()/destroy() between successive initPlayer() calls on that
      // path (see the leading stopTick() now inside initPlayer() itself,
      // which covers that gap defensively too).
      return () => {
        // Invalidate any callback still in flight from this instance even
        // if destroy() below doesn't fully suppress a trailing event.
        instanceIdRef.current += 1;
        stopTick();
        playerRef.current?.destroy();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoId]);

    // Expose playSegment + pauseVideo via useImperativeHandle
    const pauseVideoFn = useCallback(() => {
      if (!playerRef.current || !playerReadyRef.current) return;
      playerRef.current.pauseVideo();
    }, []);

    // Resumes playback from wherever the player currently sits — unlike
    // playSegment/seekTo, this never seeks. Used by the Listening Mode
    // Play/Pause control, where pausing must preserve the current timestamp.
    //
    // Exception: the very first playback of an instance with an armed start
    // target (a resumed lesson) seeks to that target first, in the same user
    // gesture, and aligns the per-sentence auto-pause with the selected
    // sentence — otherwise the first Play/Space would start the video at 0:00
    // (and, outside continuous mode, auto-pause against sentence 1's end).
    // After the instance has played once, this is a plain resume again, so
    // Pause → Play continues from the paused playhead.
    const playVideoFn = useCallback(() => {
      if (!playerRef.current || !playerReadyRef.current) return;
      isPausedRef.current = false;
      const target = hasStartedPlaybackRef.current ? null : startTargetRef.current;
      if (target && segmentsRef.current[target.segmentIndex]) {
        activeSegmentIdxRef.current = target.segmentIndex;
        pendingManualTargetRef.current = target.segmentIndex;
        setCurrentSegmentIndex(target.segmentIndex);
        playerRef.current.seekTo(target.timeSec, true);
      }
      playerRef.current.playVideo();
    }, [setCurrentSegmentIndex]);

    const playSegmentFn = useCallback(
      (segIdx: number, fromSec?: number) => {
        const seg = segmentsRef.current[segIdx];
        if (!seg || !playerRef.current || !playerReadyRef.current) return;
        // Explicit navigation supersedes any armed resume target.
        startTargetRef.current = null;
        activeSegmentIdxRef.current = segIdx;
        pendingManualTargetRef.current = segIdx;
        isPausedRef.current = false;
        // YouTube's seekTo() snaps to the nearest keyframe with run-to-run jitter, so
        // seeking exactly to seg.start sometimes lands a beat past it and clips the
        // first word. Seeking slightly earlier keeps that jitter on the silent side.
        const startSec =
          typeof fromSec === "number" && Number.isFinite(fromSec) && fromSec >= 0
            ? fromSec
            : Math.max(0, seg.start - SEGMENT_START_PRE_ROLL_SEC);
        playerRef.current.seekTo(startSec, true);
        playerRef.current.playVideo();
      },
      []
    );

    const seekToFn = useCallback((timeSec: number, autoPlay = false) => {
      if (!playerRef.current || !playerReadyRef.current) return;
      startTargetRef.current = null;
      playerRef.current.seekTo(timeSec, true);
      if (autoPlay) playerRef.current.playVideo();
    }, []);

    const setPlaybackRateFn = useCallback((rate: number) => {
      playbackRateRef.current = rate;
      if (!playerRef.current || !playerReadyRef.current) return;
      playerRef.current.setPlaybackRate(rate);
    }, []);

    const setStartTargetFn = useCallback((target: PlayerStartTarget | null) => {
      if (hasStartedPlaybackRef.current) return false;
      startTargetRef.current = target;
      return true;
    }, []);

    const getLivePlayheadSecFn = useCallback((): number | null => {
      if (!playerRef.current || !playerReadyRef.current || !hasStartedPlaybackRef.current) return null;
      const t = playerRef.current.getCurrentTime?.();
      return typeof t === "number" && Number.isFinite(t) ? t : null;
    }, []);

    useImperativeHandle(ref, () => ({
      setStartTarget: setStartTargetFn,
      getLivePlayheadSec: getLivePlayheadSecFn,
      playSegment: playSegmentFn,
      playVideo: playVideoFn,
      pauseVideo: pauseVideoFn,
      seekTo: seekToFn,
      setPlaybackRate: setPlaybackRateFn,
    }));

    return (
      <div className="relative w-full h-full overflow-hidden">
        <div ref={containerRef} className="w-full h-full" />
        {/* Glass pane: intercepts all pointer events before they reach the cross-origin
            YouTube iframe, so hovering the video never triggers YouTube's own hover UI
            (title/branding overlay). Sits above the iframe with no visual styling of its
            own, so layout/appearance is unaffected. */}
        <div className="absolute inset-0" style={{ pointerEvents: "auto" }} aria-hidden="true" />
      </div>
    );
  }
);

export default YouTubePlayer;
