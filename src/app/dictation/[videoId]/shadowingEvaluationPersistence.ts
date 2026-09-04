// =====================================================
// sessionStorage-backed map of per-sentence Shadowing evaluations
// =====================================================
//
// Follows the same convention as sessionPersistence.ts's dictation-session
// snapshot: session-scoped only (cleared on tab close), never sent anywhere.
// See "Shadowing and Pronunciation Practice Plan.md" §11.

import type { SentenceEvaluation } from "./types";

export type ShadowingEvaluationMap = Record<number, SentenceEvaluation>;

const STORAGE_PREFIX = "dictation.shadowing-evaluations.";

function storageKey(videoId: string): string {
  return `${STORAGE_PREFIX}${videoId}`;
}

export function saveShadowingEvaluations(videoId: string, evaluations: ShadowingEvaluationMap): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(videoId), JSON.stringify(evaluations));
  } catch {
    // sessionStorage can throw (private browsing, quota exceeded) — persistence
    // is a recovery nicety, never something evaluation should fail over.
  }
}

export function loadShadowingEvaluations(videoId: string): ShadowingEvaluationMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(storageKey(videoId));
    if (!raw) return {};
    return JSON.parse(raw) as ShadowingEvaluationMap;
  } catch {
    return {};
  }
}
