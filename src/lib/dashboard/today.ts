import type { DashboardWeek, LibraryItem } from "@/lib/types/learning";
import type { VocabularyStatsResponse } from "@/lib/types";
import { goalProgress } from "./week";

/**
 * The Dashboard's "what's left today" rules (plan §4.5.9, §4.5.11). They
 * replace the old Next up card (selectFocus), whose one pick always repeated
 * a card further down. Each task now lives in ONE card (resuming and the
 * sentences in Continue, the words in the review deck); the hero's Today list
 * only says what is left and jumps there. The first open row is the hero's
 * one amber "start here"; with nothing left, "Start a new video" is.
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

/** Today's goal as the Today list needs it. */
export interface GoalToday {
  met: boolean;
  /** Whole minutes still to practise (rounded up, so shown + left = goal); 0 once met. */
  minutesLeft: number;
}

export function goalToday(week: DashboardWeek): GoalToday {
  const { met } = goalProgress(week);
  if (met) return { met, minutesLeft: 0 };
  const todaySec = week.days.find((d) => d.date === week.today)?.activeSec ?? 0;
  return { met, minutesLeft: Math.max(1, Math.ceil((week.goalMinutes * 60 - Math.max(0, todaySec)) / 60)) };
}

export const practiceHeadline = (minutesLeft: number) => `${minutesLeft} min to today's goal`;

export type TodayRow =
  /** Goal not met: practise more — resume the Continue video, or start one when nothing is unfinished. */
  | { kind: "practice"; headline: string; via: "continue" | "new-video" }
  | { kind: "sentences"; headline: string }
  | { kind: "words"; done: false; headline: string }
  | { kind: "words"; done: true; reviewed: number };

/** A row still to do (everything but the ticked "N words reviewed today"). */
export type OpenTodayRow = Exclude<TodayRow, { done: true }>;
export const isOpenRow = (row: TodayRow): row is OpenTodayRow => !(row.kind === "words" && row.done);

export interface TodayInputs {
  /** The ONE Continue item (ready null = nothing unfinished). */
  resume: Source<LibraryItem | null>;
  words: Source<Pick<VocabularyStatsResponse, "due" | "reviewable">>;
  /** Distinct words reviewed today (the XP day's activity); null when XP is unavailable. */
  wordsReviewedToday: number | null;
  /** Today's goal; an error when the week is unavailable. */
  goal: Source<GoalToday>;
}

export interface TodayPlanResult {
  rows: TodayRow[];
  allDone: boolean;
  /**
   * The hero's one amber action, once every source has answered: `row` = the
   * first open row; `new-video` = nothing left to do, so "Start a new video";
   * null while something is still loading (nothing is singled out yet).
   */
  next: "row" | "new-video" | null;
}

/**
 * What's left today: practice time toward the goal (when not met yet), then
 * the sentences of the current round, then words. A row appears only when
 * there is something to do, or when the words were reviewed today and none
 * are left. "All done" is a claim about everything, so it needs every source
 * answered: a failed or pending source is never read as "nothing left".
 */
export function todayPlan({ resume, words, wordsReviewedToday, goal }: TodayInputs): TodayPlanResult {
  const rows: TodayRow[] = [];
  // Practising needs a video: resume the unfinished one, else start one. Unknown either way → no row.
  if (goal.status === "ready" && !goal.data.met && resume.status === "ready") {
    rows.push({ kind: "practice", headline: practiceHeadline(goal.data.minutesLeft), via: resume.data ? "continue" : "new-video" });
  }
  const sentences = resume.status === "ready" ? sentencesToReview(resume.data) : null;
  if (sentences) rows.push({ kind: "sentences", headline: sentencesHeadline(sentences.count) });
  if (words.status === "ready") {
    const { due, reviewable } = words.data;
    if (reviewable > 0) rows.push({ kind: "words", done: false, headline: vocabularyHeadline(due > 0 ? "due" : "new", due) });
    else if (wordsReviewedToday !== null && wordsReviewedToday > 0) rows.push({ kind: "words", done: true, reviewed: wordsReviewedToday });
  }
  const allDone = goal.status === "ready" && goal.data.met && resume.status === "ready" && words.status === "ready" && !rows.some(isOpenRow);
  const settled = goal.status !== "pending" && resume.status !== "pending" && words.status !== "pending";
  const next = !settled ? null : rows.some(isOpenRow) ? "row" : "new-video";
  return { rows, allDone, next };
}
