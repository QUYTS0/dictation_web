import { SELECTION } from "./config";
import type { HighlightCandidate } from "./types";

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Density-limited final selection over one segment's already overlap-
 * resolved candidates. A sentence with nothing meeting MIN_SCORE_THRESHOLD
 * gets zero highlights — nothing is force-added for visual consistency.
 */
export function selectFinalCandidates(resolved: HighlightCandidate[], segmentText: string): HighlightCandidate[] {
  const totalWords = wordCount(segmentText);
  const maxHighlightedWords = Math.floor(totalWords * SELECTION.MAX_HIGHLIGHT_TOKEN_PERCENTAGE);

  const eligible = [...resolved]
    .filter((c) => c.score >= SELECTION.MIN_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.start - b.start);

  const selected: HighlightCandidate[] = [];
  let highlightedWords = 0;

  for (const candidate of eligible) {
    if (selected.length >= SELECTION.MAX_HIGHLIGHTS_PER_SENTENCE) break;

    const candidateWords = wordCount(candidate.originalText);
    if (highlightedWords + candidateWords > maxHighlightedWords && selected.length > 0) continue;

    const tooClose = selected.some((s) => {
      const gapStart = Math.min(s.end, candidate.end);
      const gapEnd = Math.max(s.start, candidate.start);
      if (gapEnd <= gapStart) return true; // still overlapping (shouldn't happen post-overlap-resolution, defensive)
      const gapText = segmentText.slice(gapStart, gapEnd);
      return wordCount(gapText) < SELECTION.MIN_TOKEN_DISTANCE_BETWEEN_HIGHLIGHTS;
    });
    if (tooClose) continue;

    selected.push(candidate);
    highlightedWords += candidateWords;
  }

  return selected.sort((a, b) => a.start - b.start);
}
