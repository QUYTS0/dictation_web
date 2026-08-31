"use client";

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { usePlayerStore } from "@/store/playerStore";
import { findSegmentIndexAtTime } from "@/lib/utils/segment";
import type { TranscriptSegment } from "@/lib/types";

export interface YouTubePlayerHandle {
  playSegment: (segIdx: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (timeSec: number, autoPlay?: boolean) => void;
  setPlaybackRate: (rate: number) => void;
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

// Small safety margin subtracted from a segment's start time before seeking, so that
// YouTube's keyframe-snapping jitter on seekTo() can't clip the first spoken word.
const SEGMENT_START_PRE_ROLL_SEC = 0.2;

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    YT: any;
    onYouTubeIframeAPIReady: () => void;
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

    const setStatus = usePlayerStore((s) => s.setStatus);
    const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
    const setDuration = usePlayerStore((s) => s.setDuration);
    const setCurrentSegmentIndex = usePlayerStore((s) => s.setCurrentSegmentIndex);

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

    const startTick = useCallback(() => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = setInterval(() => {
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
      if (playerRef.current) {
        playerRef.current.destroy();
      }
      playerReadyRef.current = false;

      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          rel: 0,
          modestbranding: 1,
          // We show our own script/transcript UI instead, so force YouTube's native
          // captions off — otherwise a viewer's own YouTube "always show captions"
          // account preference can override the unset default and show them anyway.
          cc_load_policy: 0,
        },
        events: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onReady: (event: any) => {
            playerReadyRef.current = true;
            setStatus("ready");
            setDuration(event.target.getDuration());
            event.target.setPlaybackRate(playbackRateRef.current);
            console.log("[YouTubePlayer] player ready, videoId=", videoId);
            onReadyRef.current?.();
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onStateChange: (event: any) => {
            if (event.data === window.YT.PlayerState.PLAYING) {
              setStatus("playing");
              isPausedRef.current = false;
              startTick();
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
    }, [videoId, setStatus, setDuration, startTick, stopTick]);

    // Load the YouTube IFrame API script once
    useEffect(() => {
      if (typeof window === "undefined") return;

      setStatus("loading");

      if (window.YT && window.YT.Player) {
        initPlayer();
        return;
      }

      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      const firstScript = document.getElementsByTagName("script")[0];
      firstScript?.parentNode?.insertBefore(tag, firstScript);

      window.onYouTubeIframeAPIReady = () => {
        initPlayer();
      };

      return () => {
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
    const playVideoFn = useCallback(() => {
      if (!playerRef.current || !playerReadyRef.current) return;
      isPausedRef.current = false;
      playerRef.current.playVideo();
    }, []);

    const playSegmentFn = useCallback(
      (segIdx: number) => {
        const seg = segmentsRef.current[segIdx];
        if (!seg || !playerRef.current || !playerReadyRef.current) return;
        activeSegmentIdxRef.current = segIdx;
        pendingManualTargetRef.current = segIdx;
        isPausedRef.current = false;
        // YouTube's seekTo() snaps to the nearest keyframe with run-to-run jitter, so
        // seeking exactly to seg.start sometimes lands a beat past it and clips the
        // first word. Seeking slightly earlier keeps that jitter on the silent side.
        playerRef.current.seekTo(Math.max(0, seg.start - SEGMENT_START_PRE_ROLL_SEC), true);
        playerRef.current.playVideo();
      },
      []
    );

    const seekToFn = useCallback((timeSec: number, autoPlay = false) => {
      if (!playerRef.current || !playerReadyRef.current) return;
      playerRef.current.seekTo(timeSec, true);
      if (autoPlay) playerRef.current.playVideo();
    }, []);

    const setPlaybackRateFn = useCallback((rate: number) => {
      playbackRateRef.current = rate;
      if (!playerRef.current || !playerReadyRef.current) return;
      playerRef.current.setPlaybackRate(rate);
    }, []);

    useImperativeHandle(ref, () => ({
      playSegment: playSegmentFn,
      playVideo: playVideoFn,
      pauseVideo: pauseVideoFn,
      seekTo: seekToFn,
      setPlaybackRate: setPlaybackRateFn,
    }));

    return (
      <div className="w-full h-full overflow-hidden">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    );
  }
);

export default YouTubePlayer;
