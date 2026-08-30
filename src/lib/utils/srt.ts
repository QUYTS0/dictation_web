import type { CueItem } from "./segment";

const SRT_TIMESTAMP_RE = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;

function parseTimestampMs(raw: string): number | null {
  const match = SRT_TIMESTAMP_RE.exec(raw);
  if (!match) return null;
  const [, hh, mm, ss, ms] = match;
  return (Number(hh) * 3600 + Number(mm) * 60 + Number(ss)) * 1000 + Number(ms);
}

/**
 * Parses standard .srt subtitle text into caption cues (offset/duration in
 * ms, matching the shape YouTube's caption API returns) so an uploaded file
 * can be run through the same mergeIntoSentences() pipeline as YouTube
 * captions — real per-cue timestamps instead of the manual-paste fallback's
 * estimated-by-word-count timing.
 */
export function parseSrt(content: string): CueItem[] {
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const normalized = withoutBom.replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  const cues: CueItem[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    // Cue index is an optional leading numeric line — skip it if present.
    const timeLineIdx = /^\d+$/.test(lines[0]?.trim() ?? "") ? 1 : 0;
    const timeLine = lines[timeLineIdx];
    if (!timeLine || !timeLine.includes("-->")) continue;

    const [startRaw, endRaw] = timeLine.split("-->");
    const startMs = parseTimestampMs(startRaw ?? "");
    const endMs = parseTimestampMs(endRaw ?? "");
    if (startMs === null || endMs === null || endMs <= startMs) continue;

    const text = lines
      .slice(timeLineIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "") // strip formatting tags like <i>, <b>
      .replace(/\{[^}]+\}/g, "") // strip ASS-style position/style tags
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;

    cues.push({ text, offset: startMs, duration: endMs - startMs });
  }
  return cues;
}
