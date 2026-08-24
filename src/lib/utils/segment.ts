// =====================================================
// Transcript segment utilities — binary search + hints
// =====================================================

import type { HintLevel, HintResult } from "@/lib/types";

export interface TimedSegment {
  start: number;
  end: number;
}

/**
 * Binary-search to find the segment whose time range contains `currentTimeSec`.
 * Returns the segment index (into the segments array), or -1 if not found.
 * Generic over any segment shape with start/end (e.g. TranscriptSegment or
 * the listening-mode's combined EN+VI segments).
 */
export function findSegmentIndexAtTime<T extends TimedSegment>(
  segments: T[],
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
export function getSegmentAtTime<T extends TimedSegment>(
  segments: T[],
  currentTimeSec: number
): T | null {
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

/**
 * Masks every letter/digit with "_" while preserving spaces and punctuation,
 * so the sentence's word count, word lengths, and punctuation are visible
 * without revealing any actual letters. Used by Easy mode's always-on shape
 * hint (distinct from the numbered hint levels above, which are opt-in).
 */
export function getWordShapeMask(text: string): string {
  return text.replace(/[A-Za-z0-9]/g, "_");
}

// ---- Manual transcript fallback ----

// Average spoken English pace (~150 wpm) used to estimate segment timing
// when a real transcript can't be fetched (e.g. captions disabled/unavailable).
const WORDS_PER_SECOND = 2.5;
const MIN_MANUAL_SEGMENT_SECONDS = 1.5;

export interface ManualSegmentInput {
  segmentIndex: number;
  start: number;
  end: number;
  text: string;
}

/**
 * Splits a manually pasted transcript into sentence-level segments with
 * estimated (not real) timestamps, so a dictation session can proceed even
 * when no real caption timing is available. Timing is approximate — users
 * can use replay/seek to resync as they go.
 */
export function buildManualSegmentsFromText(text: string): ManualSegmentInput[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let cursor = 0;
  return sentences.map((sentenceText, i) => {
    const wordCount = sentenceText.split(/\s+/).filter(Boolean).length;
    const duration = Math.max(wordCount / WORDS_PER_SECOND, MIN_MANUAL_SEGMENT_SECONDS);
    const start = cursor;
    const end = start + duration;
    cursor = end;
    return {
      segmentIndex: i,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      text: sentenceText,
    };
  });
}

// ---------------------------------------------------------------------------
// Merge very short YouTube caption cues into sentence-level segments.
// YouTube auto-captions often emit 1-3 word cues; we group them into
// natural sentences (ended by . ! ?) up to a max duration.
//
// Pipeline:
//   1. normalizeCues   – convert offsets/durations to seconds; compute real
//                        end times using next cue's start (avoiding YouTube's
//                        inflated "display duration").
//   2. expandMultiSentenceCues – split single cues that contain multiple
//                        sentences (e.g. "Jake. Do you think…") into
//                        individual sub-cues with interpolated timestamps.
//   3. mergeExpandedCues – accumulate sub-cues into segments, splitting on
//                        hard punctuation, soft punctuation, or max duration.
//   4. mergeShortTails – re-attach tiny tail segments (< 2 s or < 3 words)
//                        back onto the preceding segment to avoid fragments
//                        like a standalone "natural."
//
// Shared by /api/transcript/generate (English) and /api/transcript/translate
// (Vietnamese YouTube captions) — both fetch raw YouTube caption cues and
// need the same sentence-merge treatment regardless of language.
// ---------------------------------------------------------------------------

export interface CueItem {
  text: string;
  duration: number;
  offset: number;
}

export interface MergedSegment {
  text: string;
  start: number;
  duration: number;
}

// A normalised cue with timestamps already converted to seconds and real end time.
interface NormalizedCue {
  text: string;
  startSec: number;
  endSec: number;
}

const MAX_SEGMENT_DURATION_SEC = 6;
const SOFT_SPLIT_DURATION_SEC = 3;
/** Segments are considered "tiny" (and merged into the preceding segment) only
 *  when BOTH conditions are true: duration shorter than MIN_SEGMENT_DURATION_SEC
 *  AND word count fewer than MIN_SEGMENT_WORDS.  Using AND (not OR) prevents
 *  merging complete short sentences like "It really does." (3 words, ~1 s) into
 *  a preceding unrelated sentence while still catching genuine one-word tail
 *  fragments like "natural." (1 word, 0.8 s). */
const MIN_SEGMENT_DURATION_SEC = 2;
const MIN_SEGMENT_WORDS = 3;

// Number of leading cues to sample when detecting offset/duration units.
const UNIT_DETECT_SAMPLE_SIZE = 10;
// Threshold separating ms from seconds: InnerTube cues are 500-10000ms; classic
// XML cues are 0.5-10s. 100 sits safely between the two ranges (10s max in
// seconds format, 500ms min in ms format) making it a reliable decision point.
const MS_DURATION_THRESHOLD = 100;

// ---------------------------------------------------------------------------
// Step 1 – normalise raw cues to seconds and compute real end times.
// ---------------------------------------------------------------------------
function normalizeCues(cues: CueItem[]): NormalizedCue[] {
  // youtube-transcript returns offsets/durations in ms for InnerTube (srv3)
  // but in seconds for the classic XML fallback.
  const sampleCues = cues.slice(0, UNIT_DETECT_SAMPLE_SIZE);
  const validDurations = sampleCues.map((c) => c.duration).filter((d) => d > 0);
  const validOffsets = sampleCues.map((c) => c.offset).filter((o) => o > 0);
  const sampleValues = [...validDurations, ...validOffsets];
  const avgSample = sampleValues.length
    ? sampleValues.reduce((a, b) => a + b, 0) / sampleValues.length
    : 0;
  if (sampleValues.length === 0) {
    console.warn("[mergeIntoSentences] no non-zero offset/duration samples; defaulting to ms");
  }
  const divisor = sampleValues.length === 0 || avgSample >= MS_DURATION_THRESHOLD ? 1000 : 1;

  // Pre-compute the next non-empty cue's start (in seconds) for every cue in
  // O(n).  YouTube's json3 timedtext "duration" is a display duration that
  // extends past the next cue's start (fade-out overlap).  Using
  // next-cue-start avoids the inflated end_sec values.
  const nextNonEmptyStartSec: (number | null)[] = new Array(cues.length).fill(null);
  let lastNonEmptyStartSec: number | null = null;
  for (let i = cues.length - 1; i >= 0; i--) {
    if (cues[i].text.replace(/\n/g, " ").trim()) {
      nextNonEmptyStartSec[i] = lastNonEmptyStartSec;
      lastNonEmptyStartSec = cues[i].offset / divisor;
    }
  }

  const result: NormalizedCue[] = [];
  for (let i = 0; i < cues.length; i++) {
    const text = cues[i].text.replace(/\n/g, " ").trim();
    if (!text) continue;
    const startSec = cues[i].offset / divisor;
    const next = nextNonEmptyStartSec[i];
    const endSec = next !== null ? next : startSec + cues[i].duration / divisor;
    result.push({ text, startSec, endSec });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 2 – split single cues that contain multiple sentences.
// Matches a sentence-ending punctuation mark followed by whitespace and an
// uppercase letter (genuine sentence boundary) and splits there, distributing
// time proportionally by character count.
//
// Lookbehind assertions require Node.js ≥ 10 (V8 ≥ 6.3), which is met by
// any supported Next.js version.
// ---------------------------------------------------------------------------
const INTRA_CUE_SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z])/;

function expandMultiSentenceCues(cues: NormalizedCue[]): NormalizedCue[] {
  const result: NormalizedCue[] = [];
  for (const cue of cues) {
    const parts = cue.text.split(INTRA_CUE_SENTENCE_SPLIT);
    if (parts.length <= 1) {
      result.push(cue);
      continue;
    }
    // Distribute the cue's time proportionally by character count.
    const totalDuration = cue.endSec - cue.startSec;
    const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
    let charPos = 0;
    for (const part of parts) {
      const startFrac = charPos / totalChars;
      charPos += part.length;
      const endFrac = charPos / totalChars;
      result.push({
        text: part.trim(),
        startSec: cue.startSec + startFrac * totalDuration,
        endSec: cue.startSec + endFrac * totalDuration,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 3 – accumulate sub-cues into segments.
// ---------------------------------------------------------------------------
function mergeExpandedCues(cues: NormalizedCue[]): MergedSegment[] {
  const result: MergedSegment[] = [];
  let buf: string[] = [];
  let start = 0;
  let end = 0;

  for (const cue of cues) {
    if (buf.length === 0) start = cue.startSec;
    buf.push(cue.text);
    end = cue.endSec;

    const sentence = buf.join(" ").trim();
    const duration = end - start;
    const endsWithHardPunctuation = /[.!?]$/.test(sentence);
    const endsWithSoftPunctuation = /[,;]$/.test(sentence);

    if (
      endsWithHardPunctuation ||
      duration >= MAX_SEGMENT_DURATION_SEC ||
      (endsWithSoftPunctuation && duration >= SOFT_SPLIT_DURATION_SEC)
    ) {
      result.push({ text: sentence, start, duration });
      buf = [];
    }
  }

  if (buf.length > 0) {
    result.push({ text: buf.join(" ").trim(), start, duration: end - start });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 4 – merge very short tail segments back onto the preceding segment.
// A "tail" is any segment that is shorter than MIN_SEGMENT_DURATION_SEC or
// has fewer words than MIN_SEGMENT_WORDS.  This prevents standalone fragments
// like "natural." (0.8 s) that arise when a max-duration cutoff fires just
// before the sentence-ending word.
// ---------------------------------------------------------------------------
function mergeShortTails(segments: MergedSegment[]): MergedSegment[] {
  if (segments.length <= 1) return segments;
  const result: MergedSegment[] = [];
  for (const seg of segments) {
    const wordCount = seg.text.trim().split(/\s+/).filter(Boolean).length;
    const isTiny = seg.duration < MIN_SEGMENT_DURATION_SEC && wordCount < MIN_SEGMENT_WORDS;
    if (isTiny && result.length > 0) {
      const prev = result[result.length - 1];
      const newEnd = seg.start + seg.duration;
      result[result.length - 1] = {
        text: prev.text + " " + seg.text,
        start: prev.start,
        duration: newEnd - prev.start,
      };
    } else {
      result.push({ ...seg });
    }
  }
  return result;
}

export function mergeIntoSentences(cues: CueItem[]): MergedSegment[] {
  const normalized = normalizeCues(cues);
  const expanded = expandMultiSentenceCues(normalized);
  const merged = mergeExpandedCues(expanded);
  return mergeShortTails(merged);
}
