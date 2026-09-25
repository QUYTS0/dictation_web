import { normalizeText } from "@/lib/utils/text";
import type { VocabularyItem } from "@/lib/types";

export function normalizeVocabularyTerm(term: string): string {
  return normalizeText(term, "relaxed").trim();
}

/**
 * Upper bound on how many vocabulary items can be selected for a bulk
 * action (currently: bulk delete) in one request. Imported by BOTH the
 * client (Vocabulary Bank page — disables further checkbox selection once
 * reached, so the limit is discovered in the UI, not from a failed request)
 * and the server (POST /api/vocabulary/bulk-delete — rejects an over-cap
 * request) from this single shared module, so the two can never drift. In
 * normal use the server-side check is unreachable defense-in-depth, since
 * the client never lets a request exceed it.
 */
export const MAX_BULK_SELECTABLE_ITEMS = 100;

// ---- Word/phrase/sentence classification (shared by the Vocabulary Bank
// page and the dictation practice page's saved-items list) ----

export type VocabularyItemKind = "word" | "phrase" | "sentence";

function normalizeComparableWhitespace(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Word vs. phrase vs. sentence is never a stored column — it's inferred
 *  from the saved text itself, consistently everywhere it's needed (this
 *  function is the single implementation; the dictation page's
 *  `inferSavedItemType` in helpers.ts delegates here). A "sentence" is a
 *  saved term that equals its own sentence_context verbatim (the "save
 *  whole sentence" action); anything else is a phrase if it has more than
 *  one word, otherwise a word. */
export function inferVocabularyItemKind(
  item: Pick<VocabularyItem, "term" | "sentence_context">
): VocabularyItemKind {
  const normalizedTerm = normalizeComparableWhitespace(item.term);
  const normalizedSentence = normalizeComparableWhitespace(item.sentence_context);
  if (normalizedTerm && normalizedTerm === normalizedSentence) return "sentence";
  return normalizedTerm.split(" ").filter(Boolean).length <= 1 ? "word" : "phrase";
}

// ---- SRS-derived learning status (Vocabulary Bank) ----

export type VocabularyLearningStatus = "new" | "learning" | "due";

/**
 * Classifies a saved item's learning status purely from the existing SM-2
 * fields (see supabase/migrations/003_vocabulary_srs.sql) — no separate
 * status column exists or is needed.
 *
 * `last_reviewed_at` (not `repetitions`, not `next_review_at` alone) is the
 * only reliable "has this ever been graded" signal: `next_review_at`
 * defaults to `now()` at insert time, so a never-reviewed item is *always*
 * "due" by that field alone — checking it first would wrongly call every
 * new save "due for review". And a failed review (grade "again") resets
 * `repetitions` to 0 exactly like a fresh item, so `repetitions === 0` can't
 * distinguish "never reviewed" from "just failed a review" either — only
 * `last_reviewed_at` (always set, even on "again") survives that reset.
 *
 * Must stay in lockstep with the equivalent SQL predicate in
 * GET /api/vocabulary/stats (src/app/api/vocabulary/stats/route.ts) — the
 * two can't literally share code across TS/SQL, so a shared test seeds
 * fixtures spanning all three buckets and checks both agree.
 */
export function getVocabularyLearningStatus(
  item: Pick<VocabularyItem, "next_review_at" | "last_reviewed_at">,
  now: Date = new Date()
): VocabularyLearningStatus {
  if (!item.last_reviewed_at) return "new";
  const nextReviewAtMs = item.next_review_at ? new Date(item.next_review_at).getTime() : 0;
  return nextReviewAtMs <= now.getTime() ? "due" : "learning";
}

/**
 * Whether an item is currently admissible into the review queue — mirrors
 * GET /api/vocabulary/review's exact admission filter
 * (`next_review_at <= now()`, regardless of `last_reviewed_at`) exactly, so
 * the Vocabulary Bank's "reviewable" count can never drift from what the
 * queue would actually return.
 *
 * Deliberately independent of `getVocabularyLearningStatus`: every
 * never-reviewed item happens to also be reviewable today, only because
 * every insert defaults `next_review_at` to `now()` (so it's always in the
 * past by the time this is read) — but that's an insert-time implementation
 * detail, not a rule this predicate should assume. A `status: "new"` item
 * with a `next_review_at` in the future (not possible via today's insert
 * path, but not ruled out by the schema either) must read as
 * `reviewable: false`, not "new therefore reviewable".
 */
export function isVocabularyItemReviewable(
  item: Pick<VocabularyItem, "next_review_at">,
  now: Date = new Date()
): boolean {
  const nextReviewAtMs = item.next_review_at ? new Date(item.next_review_at).getTime() : 0;
  return nextReviewAtMs <= now.getTime();
}

/** True when a canonical form exists and is meaningfully different from the
 *  surface term it was derived from (e.g. "give up" vs. "given up") — the
 *  signal used to decide whether a UI should show the canonical form as the
 *  primary title with an "In this sentence: {surface}" line, or just the
 *  surface term alone when they're the same. Comparison reuses the same
 *  relaxed normalization as vocabulary dedup (case/punctuation-insensitive),
 *  not a new ad hoc comparison. */
export function canonicalFormDiffersFromSurface(
  canonicalForm: string | null | undefined,
  surfaceTerm: string
): canonicalForm is string {
  if (!canonicalForm) return false;
  return normalizeVocabularyTerm(canonicalForm) !== normalizeVocabularyTerm(surfaceTerm);
}
