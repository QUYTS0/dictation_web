// =====================================================
// sessionStorage mirror of per-sentence Shadowing evaluations
// =====================================================
//
// Phase 4: the SERVER is the source of truth for saved recordings and their
// results (see shadowingServerMerge.ts). This mirror is only a fast local
// cache and a place for results that are not saved yet, scoped to exactly
// one (user, video, transcript revision, round) — a different account, a
// regenerated script or a restarted round can never read another scope's
// entries. Structured JSON only: no audio and no recovery tokens.

import type { SentenceEvaluation } from "./types";

export type ShadowingEvaluationMap = Record<number, SentenceEvaluation>;

export interface ShadowingCacheScope {
  /** null for a signed-out visitor (nothing is saved server-side then). */
  userId: string | null;
  videoId: string;
  transcriptId: string | null | undefined;
  /** null until the page knows its round. */
  roundId: string | null | undefined;
}

export const SHADOWING_CACHE_PREFIX = "dictation.shadowing.v2.";
/** Pre-Phase-4 keys (video + transcript only). Never read again — cleared. */
const LEGACY_PREFIX = "dictation.shadowing-evaluations.";

export function scopeKey(scope: ShadowingCacheScope): string {
  return [scope.userId ?? "guest", scope.videoId, scope.transcriptId ?? "none", scope.roundId ?? "none"].join(".");
}

/**
 * Whether a result started under scope `origin` may still be shown under
 * `current`: the same scope, or the only allowed transition — the page had
 * no round yet ("none") and has since adopted the round that same save
 * created/resolved, for the same user, video and revision.
 */
export function acceptsOrigin(origin: string, current: string): boolean {
  if (origin === current) return true;
  if (!origin.endsWith(".none")) return false;
  const prefix = origin.slice(0, -"none".length);
  return current.startsWith(prefix) && !current.slice(prefix.length).includes(".");
}

function storageKey(scope: ShadowingCacheScope): string {
  return `${SHADOWING_CACHE_PREFIX}${scopeKey(scope)}`;
}

function stripVolatile(map: ShadowingEvaluationMap): ShadowingEvaluationMap {
  // Nothing credential-like or in-flight is ever written to storage.
  const out: ShadowingEvaluationMap = {};
  for (const [k, entry] of Object.entries(map)) {
    const te = entry.trueEvaluation;
    out[Number(k)] = {
      ...entry,
      trueEvaluation: te?.status === "processing" ? undefined : te,
    };
  }
  return out;
}

export function saveShadowingEvaluations(scope: ShadowingCacheScope, evaluations: ShadowingEvaluationMap): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(scope), JSON.stringify(stripVolatile(evaluations)));
  } catch {
    // sessionStorage can throw (private browsing, quota exceeded) — the
    // cache is a nicety, never something evaluation should fail over.
  }
}

export function loadShadowingEvaluations(scope: ShadowingCacheScope): ShadowingEvaluationMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(storageKey(scope));
    if (!raw) return {};
    return JSON.parse(raw) as ShadowingEvaluationMap;
  } catch {
    return {};
  }
}

/**
 * Removes every Shadowing cache entry (current and pre-Phase-4 formats) —
 * on sign-out and on an account switch. Other sessionStorage data is left
 * alone.
 */
export function clearShadowingCache(): void {
  if (typeof window === "undefined") return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key && (key.startsWith(SHADOWING_CACHE_PREFIX) || key.startsWith(LEGACY_PREFIX))) doomed.push(key);
    }
    for (const key of doomed) window.sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}
