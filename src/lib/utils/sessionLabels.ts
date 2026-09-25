import type { ResumableSession } from "@/lib/types";

/** "1 attempt", "2 attempts", "0 attempts". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The legacy attempt-based accuracy stored on a learning_sessions row
 * (correct submissions ÷ all submissions, retries included — see
 * selectAccuracy in sessionStore.ts), worded as exactly that. It is not
 * video completion and not the planned latest-attempt-per-sentence metric.
 * Returns null when there are no attempts, so "unknown" is never shown as a
 * fabricated 0% or 100%.
 */
export function formatAnswerAccuracy(accuracy: number | undefined, totalAttempts: number | undefined): string | null {
  if (!totalAttempts || totalAttempts <= 0) return null;
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy)) return null;
  return `${Math.round(Math.min(100, Math.max(0, accuracy)))}% of answers correct`;
}

/**
 * current_segment_index is the shared resume point of the practice page. It
 * is written from Dictation, Shadowing and Listening alike (answer
 * auto-advance, Next/Previous, deep links, and the tab-hide/pagehide save),
 * so the label must not claim it is specifically practice progress or a
 * Listening position.
 */
export function formatResumePoint(currentSegmentIndex: number | undefined): string {
  return `Resume point: sentence ${Math.max(0, currentSegmentIndex ?? 0) + 1}`;
}

/**
 * Status badge text for a history record. A round completed before the
 * Phase 3 cutover was marked complete by the client (not by the coverage
 * rule), so it is labeled as earlier/unverified rather than "Completed".
 */
export function formatRoundStatus(session: Pick<ResumableSession, "status" | "provenance">): string {
  if (session.status === "completed") {
    return session.provenance === "legacy_unverified" ? "Completed (earlier, unverified)" : "Completed";
  }
  if (session.status === "abandoned") return "Ended";
  return "In progress";
}

/**
 * Badge text for a history record, or null when no truthful mode label
 * exists. `mode: "dictation"` only means "a learning_sessions row" — the one
 * checkpoint all three modes of the practice page share — so it says nothing
 * about which mode was used last and gets no badge. `mode: "listening"` rows
 * come from the legacy listening_sessions table, which only the old
 * standalone Listening page ever wrote, so that label is accurate.
 */
export function recordModeBadgeLabel(mode: ResumableSession["mode"]): string | null {
  return mode === "listening" ? "Listening" : null;
}
