import type { DashboardSummary, LibraryItem } from "@/lib/types/learning";
import type { VocabularyStatsResponse } from "@/lib/types";

/**
 * One input to Focus. `ready` = usable data is present (possibly stale and
 * refetching in the background); `error` = the request failed with nothing
 * cached; `pending` = first load, nothing yet.
 */
export type FocusSource<T> = { status: "pending" } | { status: "ready"; data: T } | { status: "error" };

export interface FocusInputs {
  /** Continue Learning items (the Dashboard's own query). */
  continueItems: FocusSource<LibraryItem[]>;
  vocab: FocusSource<VocabularyStatsResponse>;
  summary: FocusSource<DashboardSummary>;
}

export type FocusResult =
  | { kind: "pending" }
  /**
   * nothing-actionable: every source reached resolved and nothing qualifies.
   * unavailable: a source needed to decide the remaining path failed — never
   * read as "nothing to do".
   */
  | { kind: "hidden"; reason: "nothing-actionable" | "unavailable" }
  | { kind: "sentences"; roundId: string; videoId: string; title: string | null; needsReview: number }
  | { kind: "vocabulary"; variant: "due" | "new"; due: number; newCount: number; reviewable: number }
  | { kind: "add-video" };

export type FocusCandidate = { roundId: string; videoId: string; title: string | null; needsReview: number };

/**
 * Only the TOP Continue item, and only its active round of current
 * provenance. Later items, completed/legacy rounds and Listening-only items
 * (no round) never produce a sentence recommendation.
 *
 * needsReview = latest practice-valid Dictation answers that are incorrect:
 * `sentenceAccuracy.practiced − sentenceAccuracy.correct` from fn_round_progress,
 * proven equal to fn_round_report's `dictation.needsReview` by
 * integration/dashboard-focus-parity (plan D-2, Option B) — so Focus never
 * fetches the round report.
 */
export function focusCandidate(items: LibraryItem[]): FocusCandidate | null {
  const top = items[0];
  const round = top?.round;
  if (!round || round.status !== "active" || round.provenance !== "current") return null;
  const acc = round.progress?.sentenceAccuracy;
  const needsReview = acc ? Math.max(0, acc.practiced - acc.correct) : 0;
  return { roundId: round.roundId, videoId: top.videoId, title: top.title, needsReview };
}

/**
 * Progressive priority (plan §4.3): each rule waits only for the sources it
 * needs, so a known higher-priority action is never held back by a slower
 * lower-priority source, and a lower-priority action is never shown while a
 * higher-priority source is unresolved.
 *
 *   1. sentences  — top Continue item's active current round has needsReview > 0
 *   2. vocabulary — due > 0, else new-only (due 0, reviewable > 0, new > 0)
 *   3. add-video  — the library is provably empty
 *   4. hidden
 */
export function selectFocus({ continueItems, vocab, summary }: FocusInputs): FocusResult {
  // 1. Sentences.
  if (continueItems.status === "pending") return { kind: "pending" };
  const candidate = continueItems.status === "ready" ? focusCandidate(continueItems.data) : null;
  if (candidate && candidate.needsReview > 0) return { kind: "sentences", ...candidate };

  // 2. Vocabulary.
  if (vocab.status === "pending") return { kind: "pending" };
  if (vocab.status === "ready") {
    const { due, new: newCount, reviewable } = vocab.data;
    if (due > 0) return { kind: "vocabulary", variant: "due", due, newCount, reviewable };
    if (reviewable > 0 && newCount > 0) return { kind: "vocabulary", variant: "new", due, newCount, reviewable };
  }

  // 3. Add Video — only on a library the summary itself proves empty.
  if (summary.status === "pending") return { kind: "pending" };
  if (summary.status === "error") return { kind: "hidden", reason: "unavailable" };
  if (summary.data.libraryVideos === 0) {
    // Vocabulary resolved with nothing reviewable (else rule 2 matched). If
    // it failed, only the summary's own "no saved words" proves that — never
    // infer "nothing to review" from an API failure.
    if (vocab.status === "ready" || summary.data.vocabularyCount === 0) return { kind: "add-video" };
    return { kind: "hidden", reason: "unavailable" };
  }

  // 4. Hidden — but "could not check" is not "nothing to do".
  if (continueItems.status === "error" || vocab.status === "error") return { kind: "hidden", reason: "unavailable" };
  return { kind: "hidden", reason: "nothing-actionable" };
}

/** Maps a TanStack query to a Focus source: cached data stays `ready` while refetching or after a failed refetch. */
export function toFocusSource<T>(q: { data: T | undefined; isError: boolean }): FocusSource<T> {
  if (q.data !== undefined) return { status: "ready", data: q.data };
  if (q.isError) return { status: "error" };
  return { status: "pending" };
}
