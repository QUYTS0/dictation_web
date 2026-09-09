import { WORDS_PER_SECOND, MIN_MANUAL_SEGMENT_SECONDS, type ManualSegmentInput } from "./segment";

// Matches a line that STARTS (after trim/optional brackets) with a
// timestamp — never a number appearing mid-sentence, since `^`/`$` anchor
// the whole trimmed line. Two shapes, tried in this order:
//   H:MM:SS / HH:MM:SS   (hours 1-2 digits, minutes/seconds each 00-59)
//   M:SS / MM:SS / ...   (minutes 1-4 digits so "75:30" still works, seconds 00-59)
const TIMESTAMP_HMS_RE = /^\[?(\d{1,2}):([0-5]\d):([0-5]\d)\]?(?:\s+(.*))?$/;
const TIMESTAMP_MS_RE = /^\[?(\d{1,4}):([0-5]\d)\]?(?:\s+(.*))?$/;

interface TimestampLineMatch {
  startSec: number;
  /** Trailing same-line cue text, if any (e.g. "0:09 There are..."). */
  rest: string;
}

function matchTimestampLine(line: string): TimestampLineMatch | null {
  const hms = TIMESTAMP_HMS_RE.exec(line);
  if (hms) {
    const [, h, m, s, rest] = hms;
    return { startSec: Number(h) * 3600 + Number(m) * 60 + Number(s), rest: (rest ?? "").trim() };
  }
  const ms = TIMESTAMP_MS_RE.exec(line);
  if (ms) {
    const [, m, s, rest] = ms;
    return { startSec: Number(m) * 60 + Number(s), rest: (rest ?? "").trim() };
  }
  return null;
}

function formatSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export type TimestampPasteResult =
  /** No line looked like a timestamp — caller should fall back to the plain
   *  sentence-splitting paste path (buildManualSegmentsFromText). */
  | { kind: "not_timestamped" }
  | { kind: "ok"; segments: ManualSegmentInput[] }
  /** Timestamp lines were detected but the input is malformed — surfaced to
   *  the user rather than silently falling back, since silently reinterpreting
   *  a timestamped paste as plain prose would scramble the sentence order. */
  | { kind: "error"; message: string };

export interface ParseTimestampedPasteOptions {
  /** Known video duration, used for the final cue's end time when available. */
  videoDurationSec?: number;
}

/**
 * Parses a pasted YouTube-transcript-panel-style paste — lines that start
 * with a timestamp (optionally bracketed), each followed by that cue's text
 * either on the same line or on the following line(s) up to the next
 * timestamp line. Produces real per-cue start/end timestamps instead of the
 * plain-paste fallback's word-count estimate.
 */
export function parseTimestampedPaste(text: string, options: ParseTimestampedPasteOptions = {}): TimestampPasteResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  interface RawCue {
    startSec: number;
    textLines: string[];
  }
  const rawCues: RawCue[] = [];
  let sawTimestampLine = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = matchTimestampLine(line);
    if (match) {
      sawTimestampLine = true;
      rawCues.push({ startSec: match.startSec, textLines: match.rest ? [match.rest] : [] });
    } else if (rawCues.length > 0) {
      // Continuation text for the most recently opened cue — supports
      // multiline cue text.
      rawCues[rawCues.length - 1].textLines.push(line);
    }
    // Text appearing before any timestamp line is ignored (nothing to attach it to).
  }

  if (!sawTimestampLine) return { kind: "not_timestamped" };

  for (let i = 1; i < rawCues.length; i++) {
    if (rawCues[i].startSec < rawCues[i - 1].startSec) {
      return {
        kind: "error",
        message: `Timestamp ${formatSec(rawCues[i].startSec)} comes before the previous timestamp ${formatSec(
          rawCues[i - 1].startSec
        )}. Please check the pasted transcript's timestamps.`,
      };
    }
  }

  const cuesWithText = rawCues.filter((c) => c.textLines.join(" ").trim().length > 0);
  if (cuesWithText.length === 0) {
    return { kind: "error", message: "No cue text was found after the timestamps." };
  }

  const segments: ManualSegmentInput[] = cuesWithText.map((cue, i) => {
    const text = cue.textLines.join(" ").replace(/\s+/g, " ").trim();
    const start = cue.startSec;
    const next = cuesWithText[i + 1];

    let end: number;
    if (next && next.startSec > start) {
      end = next.startSec;
    } else if (options.videoDurationSec && options.videoDurationSec > start) {
      end = options.videoDurationSec;
    } else {
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      end = start + Math.max(wordCount / WORDS_PER_SECOND, MIN_MANUAL_SEGMENT_SECONDS);
    }

    return {
      segmentIndex: i,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      text,
    };
  });

  return { kind: "ok", segments };
}
