import { normalizeText } from "@/lib/utils/text";

export function normalizeVocabularyTerm(term: string): string {
  return normalizeText(term, "relaxed").trim();
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
