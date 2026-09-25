/**
 * Generates a real, selectable-text PDF of a transcript revision using
 * pdf-lib (MIT, actively maintained, works entirely client-side — no
 * third-party document-conversion service, no server round trip, no
 * screenshot/rasterization). Unicode text (including Vietnamese
 * diacritics and curly quotes) is supported by embedding three Noto Sans
 * subset fonts (latin / latin-ext / vietnamese, from @fontsource/noto-sans,
 * SIL Open Font License — see public/fonts/NotoSans-OFL-LICENSE.txt) and
 * picking whichever one covers each character — pdf-lib's built-in
 * "standard" fonts only support WinAnsi and can't render Vietnamese text
 * at all.
 *
 * Everything specific to pdf-lib/fontkit is dynamically imported (never at
 * module top level) so a plain TXT/SRT export — or just loading the
 * dictation page — never pulls this or the font assets into the bundle.
 */
import type { ExportableSegment } from "./transcriptExport";
import {
  buildGlyphPicker,
  buildTranscriptDocumentQueue,
  paginate,
  MARGIN,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  FOOTER_SIZE,
  COLOR_META,
  splitIntoFontRuns,
  type LaidOutLine,
} from "./transcriptPdfLayout";

const FONT_ASSET_URLS = ["/fonts/NotoSans-latin.woff", "/fonts/NotoSans-latin-ext.woff", "/fonts/NotoSans-vietnamese.woff"];

async function defaultLoadFontBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load PDF font asset: ${url}`);
  return res.arrayBuffer();
}

export interface GenerateTranscriptPdfInput {
  title: string | null;
  videoId: string;
  /** The real version number of the revision being exported, when known —
   *  never fabricated. Null omits the revision line entirely. */
  version: number | null;
  segments: ExportableSegment[];
  /** Exposed for tests only, to load font bytes from disk instead of
   *  `fetch` (unavailable/meaningless against a relative URL outside a
   *  browser). Production callers always use the default. */
  loadFontBytes?: (url: string) => Promise<ArrayBuffer>;
}

export async function generateTranscriptPdf(input: GenerateTranscriptPdfInput): Promise<Uint8Array> {
  const loadFontBytes = input.loadFontBytes ?? defaultLoadFontBytes;

  const [pdfLibModule, fontkitModule, fontBytesList] = await Promise.all([
    import("pdf-lib"),
    import("@pdf-lib/fontkit"),
    Promise.all(FONT_ASSET_URLS.map(loadFontBytes)),
  ]);
  const { PDFDocument, rgb } = pdfLibModule;
  // Interop: CJS default export can surface either as the module itself or
  // wrapped in `.default` depending on the bundler/runtime's ESM interop.
  const fontkit = (fontkitModule as { default?: unknown }).default ?? fontkitModule;

  const pdfDoc = await PDFDocument.create();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfDoc.registerFontkit(fontkit as any);

  const fonts = await Promise.all(fontBytesList.map((bytes) => pdfDoc.embedFont(bytes, { subset: true })));
  const pickFont = buildGlyphPicker(fonts);

  const sourceUrl = `https://www.youtube.com/watch?v=${input.videoId}`;
  const revisionLabel =
    input.version && input.version > 0
      ? `Revision v${input.version}`
      : null;

  const queue = buildTranscriptDocumentQueue({
    title: input.title,
    sourceUrl,
    revisionLabel,
    segments: input.segments,
    includeTimestamps: true,
  });
  const pages = paginate(queue, pickFont);
  const totalPages = pages.length;

  pages.forEach((lines: LaidOutLine[], pageIndex: number) => {
    const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    for (const line of lines) {
      const y = PAGE_HEIGHT - MARGIN - line.yFromContentTop - line.size;
      let x = MARGIN;
      for (const run of splitIntoFontRuns(line.text, pickFont)) {
        page.drawText(run.text, {
          x,
          y,
          size: line.size,
          font: run.font,
          color: rgb(line.color.r, line.color.g, line.color.b),
        });
        x += run.font.widthOfTextAtSize(run.text, line.size);
      }
    }

    const footerText = `Page ${pageIndex + 1} of ${totalPages}`;
    const footerFont = fonts[0];
    const footerWidth = footerFont.widthOfTextAtSize(footerText, FOOTER_SIZE);
    page.drawText(footerText, {
      x: PAGE_WIDTH / 2 - footerWidth / 2,
      y: MARGIN / 2,
      size: FOOTER_SIZE,
      font: footerFont,
      color: rgb(COLOR_META.r, COLOR_META.g, COLOR_META.b),
    });
  });

  return pdfDoc.save();
}
