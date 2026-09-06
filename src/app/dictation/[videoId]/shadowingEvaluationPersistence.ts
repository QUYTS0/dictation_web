// =====================================================
// sessionStorage-backed map of per-sentence Shadowing evaluations
// =====================================================
//
// Follows the same convention as sessionPersistence.ts's dictation-session
// snapshot: session-scoped only (cleared on tab close), never sent anywhere,
// structured JSON only — no audio ever touches this. See "Shadowing and
// Pronunciation Practice Plan.md" §11.

import type { SentenceEvaluation } from "./types";

export type ShadowingEvaluationMap = Record<number, SentenceEvaluation>;

const STORAGE_PREFIX = "dictation.shadowing-evaluations.";

// Keyed by videoId *and* transcript identity — a regenerated/replaced script
// reassigns segment indexes to different sentences, so a stale evaluation
// keyed only by segmentIndex could otherwise attach itself to the wrong
// sentence. Falls back to just the videoId when no transcriptId is known yet
// (e.g. before segments have loaded).
function storageKey(videoId: string, transcriptId?: string | null): string {
  return transcriptId ? `${STORAGE_PREFIX}${videoId}.${transcriptId}` : `${STORAGE_PREFIX}${videoId}`;
}

export function saveShadowingEvaluations(
  videoId: string,
  transcriptId: string | null | undefined,
  evaluations: ShadowingEvaluationMap
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(videoId, transcriptId), JSON.stringify(evaluations));
  } catch {
    // sessionStorage can throw (private browsing, quota exceeded) — persistence
    // is a recovery nicety, never something evaluation should fail over.
  }
}

export function loadShadowingEvaluations(
  videoId: string,
  transcriptId: string | null | undefined
): ShadowingEvaluationMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(storageKey(videoId, transcriptId));
    if (!raw) return {};
    return JSON.parse(raw) as ShadowingEvaluationMap;
  } catch {
    return {};
  }
}
