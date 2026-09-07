import { KIND_TIER, DOMINANCE_OVERRIDE_MARGIN } from "./config";
import type { HighlightCandidate } from "./types";

function spansOverlap(a: HighlightCandidate, b: HighlightCandidate): boolean {
  return a.start < b.end && a.end > b.start;
}

/** true when `a` should be kept over `b` for one overlapping/conflicting
 *  pair. Kind-tier dominance first (phrasal_verb/idiom > multiword_expression
 *  > topic_phrase > word) — a higher tier normally wins over a lower tier it
 *  overlaps, UNLESS the lower tier's score exceeds the higher tier's by more
 *  than DOMINANCE_OVERRIDE_MARGIN (lets a genuinely rare word still beat an
 *  unhelpful low-scoring generic phrase that happens to contain it). Same
 *  tier falls back to (score desc, start asc); final tiebreak is stable
 *  generation order, never raw span length. */
function beats(a: HighlightCandidate & { order: number }, b: HighlightCandidate & { order: number }): boolean {
  const tierA = KIND_TIER[a.kind] ?? 0;
  const tierB = KIND_TIER[b.kind] ?? 0;

  if (tierA !== tierB) {
    const [higher, lower] = tierA > tierB ? [a, b] : [b, a];
    const winner = lower.score > higher.score + DOMINANCE_OVERRIDE_MARGIN ? lower : higher;
    return winner === a;
  }
  if (a.score !== b.score) return a.score > b.score;
  if (a.start !== b.start) return a.start < b.start;
  return a.order < b.order;
}

/**
 * Deterministic overlap resolution for one segment's merged candidate list.
 * Repeated occurrences of the same phrase at different, non-overlapping
 * offsets are independent candidates here and never conflict with each
 * other — every occurrence survives (this is the direct fix for the
 * legacy renderer's first-occurrence-only bug).
 */
export function resolveOverlaps(candidates: HighlightCandidate[]): HighlightCandidate[] {
  const ordered = candidates.map((c, order) => ({ ...c, order }));

  const initialOrder = [...ordered].sort((a, b) => {
    const tierA = KIND_TIER[a.kind] ?? 0;
    const tierB = KIND_TIER[b.kind] ?? 0;
    if (tierA !== tierB) return tierB - tierA;
    if (a.score !== b.score) return b.score - a.score;
    if (a.start !== b.start) return a.start - b.start;
    return a.order - b.order;
  });

  let accepted: Array<HighlightCandidate & { order: number }> = [];

  for (const candidate of initialOrder) {
    const conflicting = accepted.filter((acc) => spansOverlap(acc, candidate));
    if (conflicting.length === 0) {
      accepted.push(candidate);
      continue;
    }
    const candidateBeatsAll = conflicting.every((acc) => beats(candidate, acc));
    if (candidateBeatsAll) {
      accepted = accepted.filter((acc) => !conflicting.includes(acc));
      accepted.push(candidate);
    }
  }

  return accepted
    .sort((a, b) => a.start - b.start)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring off the internal `order` tiebreak field
    .map(({ order, ...c }) => c);
}
