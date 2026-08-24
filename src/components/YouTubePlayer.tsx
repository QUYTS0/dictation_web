"use client";

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { usePlayerStore } from "@/store/playerStore";
import type { TranscriptSegment } from "@/lib/types";

export interface YouTubePlayerHandle {
  playSegment: (segIdx: number) => void;
  pauseVideo: () => void;
  seekTo: (timeSec: number, autoPlay?: boolean) => void;
}

interface YouTubePlayerProps {
  videoId: string;
  segments: TranscriptSegment[];
  /** Called when the player pauses at the end of a segment */
  onSegmentEnd: (segmentIndex: number) => void;
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
  function YouTubePlayer({ videoId, segments, onSegmentEnd }, ref) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const playerRef = useRef<any>(null);
    const playerReadyRef = useRef<boolean>(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const activeSegmentIdxRef = useRef<number>(0);
    const isPausedRef = useRef<boolean>(false);

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

    const startTick = useCallback(() => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = setInterval(() => {
        const player = playerRef.current;
        if (!player) return;
        const time = player.getCurrentTime?.() ?? 0;
        setCurrentTime(time);

        const segs = segmentsRef.current;
        if (!segs.length) return;

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
        },
        events: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onReady: (event: any) => {
            playerReadyRef.current = true;
            setStatus("ready");
            setDuration(event.target.getDuration());
            console.log("[YouTubePlayer] player ready, videoId=", videoId);
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

    const playSegmentFn = useCallback(
      (segIdx: number) => {
        const seg = segmentsRef.current[segIdx];
        if (!seg || !playerRef.current || !playerReadyRef.current) return;
        activeSegmentIdxRef.current = segIdx;
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

    useImperativeHandle(ref, () => ({
      playSegment: playSegmentFn,
      pauseVideo: pauseVideoFn,
      seekTo: seekToFn,
    }));

    return (
      <div className="w-full h-full overflow-hidden">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    );
  }
);

export default YouTubePlayer;
