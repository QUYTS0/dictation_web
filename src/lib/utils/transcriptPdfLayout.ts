/**
 * Pure text-layout/pagination logic for the transcript PDF export, kept
 * separate from transcriptPdf.ts (which handles dynamically importing
 * pdf-lib and fetching the embedded font assets) so this part — the part
 * with actual logic worth unit-testing — has no browser-only dependencies
 * (fetch, document) and can run against real embedded PDFFont objects in a
 * plain Node test.
 */
import type { PDFFont } from "pdf-lib";
import type { ExportableSegment } from "./transcriptExport";

export const PAGE_WIDTH = 595.28; // A4, points
export const PAGE_HEIGHT = 841.89;
export const MARGIN = 50;
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_RESERVED = 26;
const USABLE_HEIGHT = PAGE_HEIGHT - MARGIN * 2 - FOOTER_RESERVED;

export const TITLE_SIZE = 18;
export const META_SIZE = 10;
export const BODY_SIZE = 11.5;
export const TIMESTAMP_SIZE = 8.5;
export const FOOTER_SIZE = 9;

export interface RGBColor {
  r: number;
  g: number;
  b: number;
}
export const COLOR_BODY: RGBColor = { r: 0.09, g: 0.09, b: 0.09 };
export const COLOR_META: RGBColor = { r: 0.4, g: 0.4, b: 0.4 };
export const COLOR_TIMESTAMP: RGBColor = { r: 0.55, g: 0.55, b: 0.55 };

/** A font ordered by priority — the first font (in the array passed to the
 *  layout functions below) whose character set covers a given code point
 *  is used for it, so text can mix scripts (e.g. plain Latin + Vietnamese
 *  diacritics) across a set of narrower embedded font subsets. */
export function buildGlyphPicker(fonts: PDFFont[]): (codePoint: number) => PDFFont {
  const charSets = fonts.map((f) => new Set(f.getCharacterSet()));
  return (codePoint: number) => {
    for (let i = 0; i < fonts.length; i++) {
      if (charSets[i].has(codePoint)) return fonts[i];
    }
    // No embedded subset covers this code point — fall back to the first
    // font rather than throwing; pdf-lib itself would throw on draw if the
    // font truly can't encode it, which is an acceptable, rare edge case
    // for content outside the embedded subsets' coverage.
    return fonts[0];
  };
}

export interface FontRun {
  font: PDFFont;
  text: string;
}

/** Splits text into runs of consecutive characters that resolve to the
 *  same font, so widthOfTextAtSize/drawText are only ever called with a
 *  font that actually covers every character in the string passed to it. */
export function splitIntoFontRuns(text: string, pickFont: (cp: number) => PDFFont): FontRun[] {
  const runs: FontRun[] = [];
  let currentFont: PDFFont | null = null;
  let buffer = "";
  for (const ch of text) {
    const font = pickFont(ch.codePointAt(0) ?? 0);
    if (font !== currentFont) {
      if (buffer) runs.push({ font: currentFont as PDFFont, text: buffer });
      currentFont = font;
      buffer = ch;
    } else {
      buffer += ch;
    }
  }
  if (buffer) runs.push({ font: currentFont as PDFFont, text: buffer });
  return runs;
}

function measure(text: string, size: number, pickFont: (cp: number) => PDFFont): number {
  if (text.length === 0) return 0;
  return splitIntoFontRuns(text, pickFont).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, size), 0);
}

/**
 * Greedy word-wrap into physical lines no wider than maxWidth. A single
 * "word" wider than the whole line on its own (e.g. a long URL) is hard-
 * broken character by character instead of overflowing the page.
 */
export function wrapParagraph(text: string, size: number, maxWidth: number, pickFont: (cp: number) => PDFFont): string[] {
  if (text.length === 0) return [""];
  const tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
  const lines: string[] = [];
  let currentLine = "";
  let currentWidth = 0;

  for (const token of tokens) {
    const tokenWidth = measure(token, size, pickFont);

    if (tokenWidth > maxWidth && token.trim().length > 0) {
      if (currentLine.trim().length > 0) {
        lines.push(currentLine.trimEnd());
        currentLine = "";
        currentWidth = 0;
      }
      let piece = "";
      for (const ch of token) {
        const candidate = piece + ch;
        const w = measure(candidate, size, pickFont);
        if (w > maxWidth && piece.length > 0) {
          lines.push(piece);
          piece = ch;
        } else {
          piece = candidate;
        }
      }
      currentLine = piece;
      currentWidth = measure(piece, size, pickFont);
      continue;
    }

    if (currentWidth + tokenWidth > maxWidth && currentLine.trim().length > 0) {
      lines.push(currentLine.trimEnd());
      if (token.trim().length === 0) {
        currentLine = "";
        currentWidth = 0;
      } else {
        currentLine = token;
        currentWidth = tokenWidth;
      }
    } else {
      currentLine += token;
      currentWidth += tokenWidth;
    }
  }
  if (currentLine.trim().length > 0 || lines.length === 0) lines.push(currentLine.trimEnd());
  return lines.filter((l) => l.length > 0);
}

export interface LaidOutLine {
  text: string;
  size: number;
  color: RGBColor;
  /** Distance in points from the top of the content area (below the top
   *  margin) to this line's baseline-anchoring top edge. */
  yFromContentTop: number;
}

interface QueuedItem {
  text: string;
  size: number;
  color: RGBColor;
  lineHeight: number;
  gapBefore?: number;
}

function lineHeightFor(size: number): number {
  return size * 1.45;
}

/** Builds the ordered list of paragraphs/lines to lay out for a transcript
 *  export — title, source URL, revision metadata, then one paragraph per
 *  segment (with an optional leading timestamp). Pure text content only —
 *  never a translation, UI label, or icon/tooltip text. */
export function buildTranscriptDocumentQueue(input: {
  title: string | null;
  sourceUrl: string;
  revisionLabel: string | null;
  segments: ExportableSegment[];
  includeTimestamps: boolean;
}): QueuedItem[] {
  const queue: QueuedItem[] = [];
  if (input.title) {
    queue.push({ text: input.title, size: TITLE_SIZE, color: COLOR_BODY, lineHeight: lineHeightFor(TITLE_SIZE) });
  }
  queue.push({
    text: input.sourceUrl,
    size: META_SIZE,
    color: COLOR_META,
    lineHeight: lineHeightFor(META_SIZE),
    gapBefore: input.title ? 4 : 0,
  });
  if (input.revisionLabel) {
    queue.push({ text: input.revisionLabel, size: META_SIZE, color: COLOR_META, lineHeight: lineHeightFor(META_SIZE) });
  }
  input.segments.forEach((segment, i) => {
    const prefix = input.includeTimestamps ? `${formatClock(segment.start)}  ` : "";
    queue.push({
      text: prefix + segment.text,
      size: BODY_SIZE,
      color: COLOR_BODY,
      lineHeight: lineHeightFor(BODY_SIZE),
      gapBefore: i === 0 ? 14 : 6,
    });
  });
  return queue;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `[${pad(h)}:${pad(m)}:${pad(s)}]` : `[${pad(m)}:${pad(s)}]`;
}

/** Paginates a queue of items into pages of LaidOutLine[], wrapping each
 *  item's text to CONTENT_WIDTH and breaking to a new page whenever the
 *  next line wouldn't fit within the usable content height. */
export function paginate(queue: QueuedItem[], pickFont: (cp: number) => PDFFont): LaidOutLine[][] {
  const pages: LaidOutLine[][] = [[]];
  let cursorY = 0;

  const ensureRoom = (needed: number) => {
    if (cursorY + needed > USABLE_HEIGHT && pages[pages.length - 1].length > 0) {
      pages.push([]);
      cursorY = 0;
    }
  };

  for (const item of queue) {
    if (item.gapBefore) cursorY += item.gapBefore;
    const wrapped = wrapParagraph(item.text, item.size, CONTENT_WIDTH, pickFont);
    for (const line of wrapped) {
      ensureRoom(item.lineHeight);
      pages[pages.length - 1].push({ text: line, size: item.size, color: item.color, yFromContentTop: cursorY });
      cursorY += item.lineHeight;
    }
  }
  return pages;
}
