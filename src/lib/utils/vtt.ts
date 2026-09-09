import type { CueItem } from "./segment";

// WebVTT timestamps: "HH:MM:SS.mmm" or the shorter "MM:SS.mmm" (hours
// optional, per spec). Comma is not valid in VTT (unlike SRT) but a few
// generators emit it anyway — accepted leniently here.
const VTT_TIMESTAMP_RE = /(?:(\d{2}):)?(\d{2}):(\d{2})[.,](\d{3})/;

function parseTimestampMs(raw: string): number | null {
  const match = VTT_TIMESTAMP_RE.exec(raw.trim());
  if (!match) return null;
  const [, hh, mm, ss, ms] = match;
  return (Number(hh ?? 0) * 3600 + Number(mm) * 60 + Number(ss)) * 1000 + Number(ms);
}

/** Strips VTT cue-payload markup (`<b>`, `<i>`, `<c.class>`, voice spans
 *  `<v Speaker>text</v>`, timestamp tags `<00:00:01.000>`) down to plain
 *  text — tags are only ever pattern-matched and removed, never parsed as
 *  HTML/executed. */
function stripCueMarkup(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}

/**
 * Parses WebVTT subtitle text into caption cues (offset/duration in ms,
 * matching the shape YouTube's caption API returns) so an uploaded .vtt file
 * runs through the same mergeIntoSentences() pipeline as .srt uploads and
 * YouTube captions. Tolerant of an optional `WEBVTT` header, `NOTE`/`STYLE`/
 * `REGION` blocks (skipped, never parsed as cues), and an optional leading
 * cue-identifier line. Unicode cue text is preserved as-is.
 */
export function parseVtt(content: string): CueItem[] {
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const normalized = withoutBom.replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  const cues: CueItem[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    // Drop a leading "WEBVTT" header block (with optional trailing text/
    // metadata on the same line) and NOTE/STYLE/REGION blocks entirely —
    // none of these are cues.
    const firstLine = lines[0]?.trim() ?? "";
    if (/^WEBVTT/i.test(firstLine) || /^(NOTE|STYLE|REGION)(\s|$)/i.test(firstLine)) continue;

    // A cue-identifier line (arbitrary text, no "-->") may precede the
    // timing line — skip it the same way srt.ts skips a numeric index.
    const timeLineIdx = lines[0]?.includes("-->") ? 0 : 1;
    const timeLine = lines[timeLineIdx];
    if (!timeLine || !timeLine.includes("-->")) continue;

    const [startRaw, endRaw] = timeLine.split("-->");
    const startMs = parseTimestampMs(startRaw ?? "");
    // The end timestamp may be followed by cue settings (e.g. "align:start
    // line:0") on the same line — only the leading timestamp matters.
    const endMs = parseTimestampMs((endRaw ?? "").trim().split(/\s+/)[0] ?? "");
    if (startMs === null || endMs === null || endMs <= startMs) continue;

    const text = stripCueMarkup(
      lines
        .slice(timeLineIdx + 1)
        .join(" ")
        .replace(/\s+/g, " ")
    );
    if (!text) continue;

    cues.push({ text, offset: startMs, duration: endMs - startMs });
  }
  return cues;
}
