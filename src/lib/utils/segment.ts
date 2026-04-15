// =====================================================
// Transcript segment utilities — binary search + hints
// =====================================================

import type { TranscriptSegment, HintLevel, HintResult } from "@/lib/types";

/**
 * Binary-search to find the segment whose time range contains `currentTimeSec`.
 * Returns the segment index (into the segments array), or -1 if not found.
 */
export function findSegmentIndexAtTime(
  segments: TranscriptSegment[],
  currentTimeSec: number
): number {
  if (!segments.length) return -1;

  let lo = 0;
  let hi = segments.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];

    if (currentTimeSec < seg.start) {
      hi = mid - 1;
    } else if (currentTimeSec >= seg.end) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }

  return -1;
}

/**
 * Returns the segment that should be playing at `currentTimeSec`.
 * Falls back to the last segment before the current time if no exact match.
 */
export function getSegmentAtTime(
  segments: TranscriptSegment[],
  currentTimeSec: number
): TranscriptSegment | null {
  if (!segments.length) return null;

  const idx = findSegmentIndexAtTime(segments, currentTimeSec);
  if (idx !== -1) return segments[idx];

  // Fallback: most recent segment that has already started
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].start <= currentTimeSec) return segments[i];
  }

  return null;
}

// ---- Hint generation ----

/**
 * Generates a hint for the given segment text at the requested hint level.
 *
 * Level 0 — no hint (empty string)
 * Level 1 — show first letter of each word: "H__ a__ y__ d____ t___?"
 * Level 2 — show word count: "4 words"
 * Level 3 — reveal missing words (every other word)
 * Level 4 — show full answer
 */
export function getHint(text: string, level: HintLevel): HintResult {
  const words = text.trim().split(/\s+/);

  switch (level) {
    case 0:
      return { level: 0, hint: "" };

    case 1: {
      const masked = words
        .map((w) => {
          const first = w[0] ?? "_";
          const rest = "_".repeat(Math.max(w.length - 1, 0));
          return first + rest;
        })
        .join(" ");
      return { level: 1, hint: masked };
    }

    case 2:
      return { level: 2, hint: `${words.length} word${words.length !== 1 ? "s" : ""}` };

    case 3: {
      // Reveal every odd-indexed word, blank out even-indexed
      const partial = words
        .map((w, i) => (i % 2 === 1 ? w : "_".repeat(w.length)))
        .join(" ");
      return { level: 3, hint: partial };
    }

    case 4:
      return { level: 4, hint: text };

    default:
      return { level: 0, hint: "" };
  }
}
