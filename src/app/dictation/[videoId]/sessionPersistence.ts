// =====================================================
// sessionStorage-backed snapshot of the active dictation session
// =====================================================
//
// Every piece of dictation progress (segment index, typed answers, mistakes,
// combo, etc.) normally lives only in React state, so it's lost the instant
// the page component remounts — which can happen for reasons outside this
// app's control (a mobile browser reclaiming a backgrounded tab, a page
// refresh). This module snapshots that state into sessionStorage, scoped to
// the current tab and this specific video, so a remount/refresh can restore
// the session instead of dropping the user back to "Start Dictation".

import type { CheckAnswerResponse, HintLevel, UXState } from "@/lib/types";
import type { MistakeRecord, CompletedSentenceReview } from "./types";

export interface PersistedInputState {
  typedByWord: string[];
  activeWordIndex: number;
  caretPos: number;
}

export interface DictationSessionSnapshot {
  videoId: string;
  /** Signed-in user this snapshot belongs to, or null for a guest — a
   *  snapshot must never be applied to a different user sharing the same
   *  browser/tab. */
  userId: string | null;
  /** The revision (transcript_id) this snapshot's segIdx/checkResult/etc.
   *  actually refer to — a snapshot must never be applied against a
   *  different revision than the one it was captured from, since segment
   *  indices/content can differ between revisions. */
  transcriptId: string | null;
  uxState: UXState;
  currentSegIdx: number;
  checkResult: CheckAnswerResponse | null;
  wrongAttempts: number;
  hintLevel: HintLevel;
  mistakes: MistakeRecord[];
  previousReview: CompletedSentenceReview | null;
  combo: number;
  bestCombo: number;
  cleanSolveCount: number;
  isLastResultClean: boolean;
  previousRunSnapshot: { accuracy: number; totalAttempts: number } | null;
  firstAttemptBySegment: Record<number, string>;
  videoCurrentTimeSec: number;
  inputState: PersistedInputState | null;
  sessionId: string | null;
  totalAttempts: number;
  correctCount: number;
  savedAt: number;
}

// Only these uxStates represent an active/completed session worth restoring —
// transient states (loading, checking, transcript_*) either have nothing to
// recover or would leave the UI in an inconsistent in-flight state.
export const RESTORABLE_UX_STATES: ReadonlySet<UXState> = new Set([
  "playing",
  "paused_waiting_input",
  "checking_answer",
  "session_completed",
]);

const STORAGE_PREFIX = "dictation.active-session.";

function storageKey(videoId: string): string {
  return `${STORAGE_PREFIX}${videoId}`;
}

export function saveDictationSessionSnapshot(
  videoId: string,
  snapshot: Omit<DictationSessionSnapshot, "videoId" | "savedAt">
): void {
  if (typeof window === "undefined") return;
  try {
    const payload: DictationSessionSnapshot = { ...snapshot, videoId, savedAt: Date.now() };
    window.sessionStorage.setItem(storageKey(videoId), JSON.stringify(payload));
  } catch {
    // sessionStorage can throw (private browsing, quota exceeded) — persistence
    // is a recovery nicety, never something the session should fail over.
  }
}

export function loadDictationSessionSnapshot(videoId: string): DictationSessionSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(videoId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DictationSessionSnapshot;
    if (parsed.videoId !== videoId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDictationSessionSnapshot(videoId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(storageKey(videoId));
  } catch {
    // ignore
  }
}

export interface SnapshotIdentityContext {
  videoId: string;
  userId: string | null;
  transcriptId: string | null;
}

/**
 * Whether a loaded snapshot's identity matches the context it would be
 * restored into — a snapshot captured for a different user or a different
 * transcript revision must never be silently applied (segment indices and
 * content aren't comparable across revisions, and a snapshot is per-tab
 * sessionStorage that could still reflect a previous user's in-progress
 * text on a shared device). Snapshots saved before this identity scoping
 * existed have no `userId`/`transcriptId` field at all (`undefined` at
 * runtime despite the type) — treated as incompatible rather than guessed
 * at, so they're discarded once instead of risking a silent misapplication.
 */
export function isSnapshotCompatible(
  snapshot: DictationSessionSnapshot | null,
  context: SnapshotIdentityContext
): snapshot is DictationSessionSnapshot {
  if (!snapshot) return false;
  if (snapshot.videoId !== context.videoId) return false;
  if (typeof snapshot.userId === "undefined" || typeof snapshot.transcriptId === "undefined") return false;
  if (snapshot.userId !== context.userId) return false;
  if (snapshot.transcriptId !== context.transcriptId) return false;
  return true;
}
