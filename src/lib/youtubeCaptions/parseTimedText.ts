// =====================================================
// Shared timed-text parsing: YouTube's srv3 (`<p t d>`) and classic
// (`<text start dur>`) XML caption formats, plus HTML-entity decoding.
//
// Two output shapes are exposed, sharing the same regex-matching/decoding
// core:
//   - parseTimedTextXml(): CaptionCue[] in unambiguous seconds — used by
//     innerTubeProvider.ts (the new English fallback path), which has no
//     legacy numeric contract to preserve.
//   - parseTimedTextRaw(): raw {text, offset, duration}[] with each format's
//     ORIGINAL units passed through unconverted (srv3 = milliseconds,
//     classic = seconds) — byte-identical to what was previously a private
//     copy of this logic inside youtubeTranslatedCaptions.ts, which that
//     file still uses so its output (and downstream normalizeCues'
//     ms-vs-seconds auto-detection in src/lib/utils/segment.ts) is provably
//     unchanged by this extraction.
// =====================================================

import type { CaptionCue } from "./types";

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}

export interface RawTimedTextCue {
  text: string;
  /** srv3 (`<p t d>`): milliseconds. classic (`<text start dur>`): seconds.
   *  Ambiguous by design — matches src/lib/utils/segment.ts's normalizeCues,
   *  which already handles exactly this ambiguity. */
  offset: number;
  duration: number;
}

function parseSrv3Raw(xml: string): RawTimedTextCue[] {
  const result: RawTimedTextCue[] = [];
  const srv3Re = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = srv3Re.exec(xml)) !== null) {
    const offset = parseInt(match[1], 10);
    const duration = parseInt(match[2], 10);
    const inner = match[3];
    let text = "";
    const sRe = /<s[^>]*>([^<]*)<\/s>/g;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = sRe.exec(inner)) !== null) text += sMatch[1];
    if (!text) text = inner.replace(/<[^>]+>/g, "");
    text = decodeHtmlEntities(text).trim();
    if (text) result.push({ text, offset, duration });
  }
  return result;
}

function parseClassicRaw(xml: string): RawTimedTextCue[] {
  const result: RawTimedTextCue[] = [];
  const classicRe = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
  let match: RegExpExecArray | null;
  while ((match = classicRe.exec(xml)) !== null) {
    const offset = parseFloat(match[1]);
    const duration = parseFloat(match[2]);
    const text = decodeHtmlEntities(match[3]).trim();
    if (text) result.push({ text, offset, duration });
  }
  return result;
}

/** Raw passthrough, each format in its own native units — see the module
 *  doc comment. Preserved for youtubeTranslatedCaptions.ts's existing
 *  contract; new code should prefer parseTimedTextXml below. */
export function parseTimedTextRaw(xml: string): RawTimedTextCue[] {
  const srv3Cues = parseSrv3Raw(xml);
  if (srv3Cues.length > 0) return srv3Cues;
  return parseClassicRaw(xml);
}

/**
 * Parses a YouTube timedtext XML payload into cues with unambiguous
 * seconds-based timestamps (srv3's milliseconds are converted; classic's
 * seconds pass through as-is). Returns an empty array for anything that
 * doesn't match either known shape — callers decide whether that's a
 * validation failure.
 */
export function parseTimedTextXml(xml: string): CaptionCue[] {
  const srv3Cues = parseSrv3Raw(xml);
  if (srv3Cues.length > 0) {
    return srv3Cues.map((c) => ({ text: c.text, startSeconds: c.offset / 1000, durationSeconds: c.duration / 1000 }));
  }
  const classicCues = parseClassicRaw(xml);
  return classicCues.map((c) => ({ text: c.text, startSeconds: c.offset, durationSeconds: c.duration }));
}
