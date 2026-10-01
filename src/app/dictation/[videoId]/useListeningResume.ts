"use client";

import { useEffect, useRef } from "react";
import type { UXState } from "@/lib/types";

/**
 * Listening resume (plan Phase 6): once Listening mode has entered its paused
 * view, arm the player at the saved Listening checkpoint so the first
 * Play/Space starts there.
 *   - Only the checkpoint of the revision ON SCREEN is used (`progress`
 *     must be for `transcriptId`) — another revision's timestamp is never
 *     applied, and the round's Dictation/Shadowing checkpoint is never used.
 *   - Applied once per (account, video, revision); no autoplay; a
 *     legitimate backward checkpoint is honored exactly as saved.
 *   - restoreListeningPosition itself refuses once the player has played or
 *     a newer target (same-tab restore, a deliberate navigation) is armed.
 */
export function useListeningResume(opts: {
  inputMode: "dictation" | "listening" | "shadowing";
  userId: string | undefined;
  videoId: string;
  transcriptId: string | null;
  uxState: UXState;
  progress: { transcriptId: string | null; hasHistory: boolean; lastPositionSec: number } | null;
  restoreListeningPosition: (timeSec: number) => boolean;
}) {
  const { inputMode, userId, videoId, transcriptId, uxState, progress, restoreListeningPosition } = opts;
  const appliedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (inputMode !== "listening" || !userId || !transcriptId || uxState !== "paused_waiting_input") return;
    if (!progress || progress.transcriptId !== transcriptId) return;
    const key = `${userId}|${videoId}|${transcriptId}`;
    if (appliedKeyRef.current === key) return;
    appliedKeyRef.current = key;
    if (progress.hasHistory && progress.lastPositionSec > 0) restoreListeningPosition(progress.lastPositionSec);
  }, [inputMode, userId, videoId, transcriptId, uxState, progress, restoreListeningPosition]);
}
