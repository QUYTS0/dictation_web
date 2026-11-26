import type { LibraryItem } from "@/lib/types/learning";
import type { VocabularyStatsResponse } from "@/lib/types";

/**
 * The Dashboard's "what's left today" rules (plan §4.5.9). They replace the
 * old Next up card (selectFocus), whose one pick always repeated a card
 * further down. Each task now lives in ONE card (the sentences in Continue,
 * the words in the review deck); the hero's Today list only says what is
 * left and jumps there.
 */

/**
 * One Dashboard query's state. `ready` = usable data is present (possibly
 * stale and refetching in the background); `error` = the request failed with
 * nothing cached; `pending` = first load, nothing yet.
 */
export type Source<T> = { status: "pending" } | { status: "ready"; data: T } | { status: "error" };

/** Maps a TanStack query to a Source: cached data stays `ready` while refetching or after a failed refetch. */
export function toSource<T>(q: { data: T | undefined; isError: boolean }): Source<T> {
  if (q.data !== undefined) return { status: "ready", data: q.data };
  return q.isError ? { status: "error" } : { status: "pending" };
}

export interface SentencesToReview {
  roundId: string;
  videoId: string;
  title: string | null;
  /** Latest practice-valid Dictation answers that are incorrect (> 0). */
  count: number;
}

/**
 * The sentences that need another look in the Continue item's round: only
 * an active round of current provenance (never legacy, completed, abandoned
 * or a round-less Listening item). The count is
 * `sentenceAccuracy.practiced − sentenceAccuracy.correct` from
 * fn_round_progress, proven equal to fn_round_report's
 * `dictation.needsReview` by integration/dashboard-focus-parity (plan D-2,
 * Option B), so nothing has to wait for the round report. Null when none.
 */
export function sentencesToReview(item: LibraryItem | null | undefined): SentencesToReview | null {
  const round = item?.round;
  if (!item || !round || round.status !== "active" || round.provenance !== "current") return null;
  const acc = round.progress?.sentenceAccuracy;
  const count = acc ? Math.max(0, acc.practiced - acc.correct) : 0;
  return count > 0 ? { roundId: round.roundId, videoId: item.videoId, title: item.title, count } : null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const sentencesHeadline = (count: number) => `${count} ${plural(count, "sentence needs", "sentences need")} another look`;

/** Factual vocabulary lines: no order or batch-size claims (the review queue guarantees neither). */
export function vocabularyHeadline(variant: "due" | "new", due: number): string {
  return variant === "due" ? `${due} ${plural(due, "word is", "words are")} due` : "New vocabulary is ready to practice";
}

export type TodayRow =
  | { kind: "sentences"; headline: string }
  | { kind: "words"; done: false; headline: string }
  | { kind: "words"; done: true; reviewed: number };

export interface TodayInputs {
  sentences: Source<SentencesToReview | null>;
  words: Source<Pick<VocabularyStatsResponse, "due" | "reviewable">>;
  /** Distinct words reviewed today (the XP day's activity); null when XP is unavailable. */
  wordsReviewedToday: number | null;
  /** Today's goal reached; null when the week is unavailable. */
  goalMet: boolean | null;
}

/**
 * What's left today, in the old Next up order (sentences of the current
 * round, then words). A row appears only when there is something to do, or
 * when the words were reviewed today and none are left. "All done" is a
 * claim about everything, so it needs every source answered: a failed or
 * pending source is never read as "nothing left".
 */
export function todayPlan({ sentences, words, wordsReviewedToday, goalMet }: TodayInputs): { rows: TodayRow[]; allDone: boolean } {
  const rows: TodayRow[] = [];
  if (sentences.status === "ready" && sentences.data) rows.push({ kind: "sentences", headline: sentencesHeadline(sentences.data.count) });
  if (words.status === "ready") {
    const { due, reviewable } = words.data;
    if (reviewable > 0) rows.push({ kind: "words", done: false, headline: vocabularyHeadline(due > 0 ? "due" : "new", due) });
    else if (wordsReviewedToday !== null && wordsReviewedToday > 0) rows.push({ kind: "words", done: true, reviewed: wordsReviewedToday });
  }
  const allDone = goalMet === true && sentences.status === "ready" && words.status === "ready" && rows.every((r) => r.kind === "words" && r.done);
  return { rows, allDone };
}
