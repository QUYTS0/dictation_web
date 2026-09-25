/**
 * Pure, dependency-free helpers for the transcript download format menu
 * (TXT/SRT/PDF) — building the exported text content and safe filenames.
 * Kept separate from the PDF generator (transcriptPdf.ts) so a plain
 * TXT/SRT export never pulls in pdf-lib.
 */

/** The minimal per-segment shape every export format needs — decoupled
 *  from the full `TranscriptSegment` API type so these functions stay
 *  trivially unit-testable and don't accidentally depend on fields (like
 *  `textNormalized`, used for answer-matching, not display) that must
 *  never leak into an export. */
export interface ExportableSegment {
  segmentIndex: number;
  /** Seconds, matching the stored `start_sec` column — NOT the fingerprint
   *  helper's rounded-to-0.1s value. */
  start: number;
  /** Seconds, matching the stored `end_sec` column. */
  end: number;
  /** Original transcript text, exactly as stored/displayed — never the
   *  normalized/matching form, a translation, or a UI annotation. */
  text: string;
}

export type TranscriptExportFormat = "txt" | "srt" | "pdf";

export const TRANSCRIPT_EXPORT_FORMATS: readonly {
  format: TranscriptExportFormat;
  label: string;
  description: string;
  extension: string;
  mimeType: string;
}[] = [
  { format: "txt", label: "Text", description: ".txt", extension: "txt", mimeType: "text/plain;charset=utf-8" },
  { format: "srt", label: "Subtitles", description: ".srt", extension: "srt", mimeType: "application/x-subrip;charset=utf-8" },
  { format: "pdf", label: "Document", description: ".pdf", extension: "pdf", mimeType: "application/pdf" },
];

/**
 * Plain-text export — unchanged from the app's original download behavior:
 * one sentence per line, in transcript order, no timestamps or metadata.
 */
export function buildTranscriptTxt(segments: ExportableSegment[]): string {
  return segments.map((segment) => segment.text).join("\n");
}

const MS_PER_SEC = 1000;

/**
 * Converts a start/end time in seconds (the stored `start_sec`/`end_sec`
 * columns, floating point) into an SRT `HH:MM:SS,mmm` timestamp, rolling
 * milliseconds over into seconds/minutes/hours correctly.
 *
 * Deliberately rounds to the nearest whole millisecond only — never the
 * content-fingerprint helper's coarser 0.1s rounding (transcriptFingerprint.ts),
 * which exists purely to make content-equality checks tolerant of float/
 * keyframe jitter and would visibly desync subtitles from the actual audio
 * if reused here.
 */
export function formatSrtTimestamp(seconds: number): string {
  const totalMs = Math.round(seconds * MS_PER_SEC);
  const ms = totalMs % MS_PER_SEC;
  const totalSec = Math.floor(totalMs / MS_PER_SEC);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export interface SrtValidationResult {
  ok: boolean;
  /** User-facing, SRT-specific reason — set only when ok is false. */
  reason?: string;
}

/**
 * Checks whether the given segments have usable timing for an SRT export.
 * Intentionally does NOT check cross-segment relationships (gaps or
 * overlaps between consecutive cues are valid real content, not errors) —
 * only that each individual cue's own start/end are finite, nonnegative,
 * and describe a positive duration.
 */
export function validateSegmentsForSrt(segments: ExportableSegment[]): SrtValidationResult {
  if (segments.length === 0) {
    return { ok: false, reason: "There are no sentences to export yet." };
  }
  for (const segment of segments) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
      return { ok: false, reason: "This transcript is missing timing information needed for subtitles." };
    }
    if (segment.start < 0 || segment.end < 0) {
      return { ok: false, reason: "This transcript has invalid (negative) timing and can't be exported as subtitles." };
    }
    if (segment.end <= segment.start) {
      return {
        ok: false,
        reason: "This transcript has invalid sentence timing (zero or negative duration) and can't be exported as subtitles.",
      };
    }
  }
  return { ok: true };
}

/**
 * Builds a standard SubRip (.srt) file from the given segments. Throws
 * (with a user-facing message — see validateSegmentsForSrt) rather than
 * silently emitting a file with missing/invented timing or dropped cues.
 */
export function buildTranscriptSrt(segments: ExportableSegment[]): string {
  const validation = validateSegmentsForSrt(segments);
  if (!validation.ok) {
    throw new Error(validation.reason ?? "Invalid subtitle timing.");
  }

  return segments
    .map((segment, i) => {
      const cueNumber = i + 1;
      const start = formatSrtTimestamp(segment.start);
      const end = formatSrtTimestamp(segment.end);
      return `${cueNumber}\n${start} --> ${end}\n${segment.text}\n`;
    })
    .join("\n");
}

/**
 * Strips characters that are reserved/unsafe in filenames on Windows,
 * macOS, and Linux, collapses whitespace, and trims trailing dots/spaces
 * (which Windows silently rejects) — while leaving Unicode letters (e.g.
 * Vietnamese diacritics in a video title) intact, unlike the previous
 * ASCII-only `\w`-based filter.
 */
export function sanitizeFilenameBase(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return cleaned.slice(0, 120);
}

export interface ExportFilenameOptions {
  title?: string | null;
  videoId: string;
  /** The revision's real version number, when known — never fabricated;
   *  omitted from the filename entirely when unavailable rather than
   *  guessed at or labeled "latest". */
  version?: number | null;
}

export function buildExportFilename(format: TranscriptExportFormat, opts: ExportFilenameOptions): string {
  const meta = TRANSCRIPT_EXPORT_FORMATS.find((f) => f.format === format);
  const extension = meta?.extension ?? format;
  const base = sanitizeFilenameBase(opts.title ?? "") || `video-${opts.videoId}`;
  const versionSuffix = opts.version && opts.version > 0 ? `-v${opts.version}` : "";
  return `${base}${versionSuffix}.${extension}`;
}
