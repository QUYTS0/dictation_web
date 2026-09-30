"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListeningIntervalTracker } from "@/lib/practice/listeningTracker";
import { LISTENING } from "@/lib/practice/listeningTypes";
import { practiceFlushCoordinator, type FlushIdentity, type FlushTrigger } from "@/lib/practiceFlushCoordinator";
import { useListeningProgressQuery } from "@/lib/queries/listeningProgress";

export type PlaybackState = "playing" | "paused" | "buffering" | "ended";

/**
 * Listening coverage for the practice page (plan §6.3). Active only in
 * Listening mode for a signed-in user. Player PLAYING ticks go into a
 * ListeningIntervalTracker; observed intervals are handed to the app-level
 * flush coordinator — every SYNC_FLUSH_INTERVAL_SEC of playback, on pause /
 * buffering / end, on tab hide, and whenever the identity changes (mode
 * switch, another revision/video/account/round) or the page unmounts. The
 * identity — including the practice round the page was on — is the one in
 * effect while the data was observed, never re-derived later.
 *
 * The checkpoint (resume position) is only ever a playhead sampled while
 * PLAYING since the previous hand-over: opening Listening and leaving
 * without playing sends nothing, so it can't overwrite a saved checkpoint
 * with the player's default 0 or with a stale position.
 */
export function useListeningCoverage(opts: {
  enabled: boolean;
  userId: string | undefined;
  videoId: string;
  transcriptId: string | null;
  /** The page's current practice round (null = none yet). */
  roundId: string | null;
}) {
  const { enabled, userId, videoId, transcriptId, roundId } = opts;
  const identity = useMemo<FlushIdentity | null>(
    () => (enabled && userId ? { userId, videoId, transcriptId, roundId } : null),
    [enabled, userId, videoId, transcriptId, roundId]
  );
  const identityRef = useRef<FlushIdentity | null>(identity);
  const [tracker] = useState(() => new ListeningIntervalTracker());

  const handOver = useCallback((id: FlushIdentity | null, trigger: FlushTrigger | null, close: boolean) => {
    if (close) tracker.stop();
    const intervals = tracker.take();
    const checkpoint = tracker.takeCheckpoint();
    if (!id) return;
    practiceFlushCoordinator.record("listening", id, intervals, checkpoint);
    if (trigger) void practiceFlushCoordinator.requestFlush(trigger);
  }, [tracker]);

  // Identity changes / leaving Listening mode / unmount: close what this
  // identity observed and flush it under that identity.
  useEffect(() => {
    identityRef.current = identity;
    return () => {
      handOver(identity, "mode", true);
      identityRef.current = null;
    };
  }, [identity, handOver]);

  // Tab hidden / page hide: hand over before the app-level observer flushes.
  useEffect(() => {
    if (!identity) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") handOver(identityRef.current, "visibility", true);
    };
    const onPageHide = () => handOver(identityRef.current, "visibility", true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [identity, handOver]);

  const onPlaybackSample = useCallback(
    (positionSec: number, rate: number) => {
      if (!identityRef.current) return;
      tracker.sample(positionSec, rate, performance.now());
      if (tracker.playedSinceTake >= LISTENING.SYNC_FLUSH_INTERVAL_SEC) handOver(identityRef.current, "periodic", false);
    },
    [tracker, handOver]
  );

  const onPlaybackStateChange = useCallback(
    (state: PlaybackState) => {
      if (state === "playing" || !identityRef.current) return;
      handOver(identityRef.current, "pause", true);
    },
    [handOver]
  );

  const progress = useListeningProgressQuery(userId, videoId, transcriptId, enabled);
  return { onPlaybackSample, onPlaybackStateChange, progress: progress.data ?? null, progressLoading: progress.isLoading };
}
