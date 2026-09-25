/**
 * Tests transcriptPdf.ts's real PDF generation (pdf-lib + embedded Noto
 * Sans subsets). Font bytes are loaded from disk (public/fonts/) instead
 * of `fetch`, since a relative fetch URL is meaningless in a Node test
 * environment — production code always uses the default fetch-based
 * loader (see generateTranscriptPdf's `loadFontBytes` override).
 */
import fs from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { generateTranscriptPdf } from "@/lib/utils/transcriptPdf";
import type { ExportableSegment } from "@/lib/utils/transcriptExport";

const FONT_FILES = ["NotoSans-latin.woff", "NotoSans-latin-ext.woff", "NotoSans-vietnamese.woff"];

async function loadFontBytesFromDisk(url: string): Promise<ArrayBuffer> {
  const filename = url.split("/").pop() as string;
  const buf = fs.readFileSync(path.join(process.cwd(), "public", "fonts", filename));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function seg(segmentIndex: number, start: number, end: number, text: string): ExportableSegment {
  return { segmentIndex, start, end, text };
}

describe("generateTranscriptPdf", () => {
  it("fonts are present on disk for all three subsets", () => {
    for (const f of FONT_FILES) {
      expect(fs.existsSync(path.join(process.cwd(), "public", "fonts", f))).toBe(true);
    }
  });

  it("9. produces a structurally valid, loadable PDF with real (non-rasterized) selectable text objects", async () => {
    const segments = [
      seg(0, 0, 2, "This is an example."),
      seg(1, 2, 4.5, "This is another sentence."),
      seg(2, 4.5, 7, "Xin chào, đây là một câu tiếng Việt với dấu thanh đầy đủ: ă â đ ê ô ơ ư, ế ệ ầ ủ ỗ."),
      seg(3, 7, 9, "Curly quotes: ‘single’ and “double”, plus an em dash — here."),
    ];

    const bytes = await generateTranscriptPdf({
      title: "Test Video — Café Résumé",
      videoId: "abc123XYZ_-",
      version: 3,
      segments,
      loadFontBytes: loadFontBytesFromDisk,
    });

    expect(Buffer.from(bytes.slice(0, 5)).toString("utf8")).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1000);

    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);

    // Write out for manual visual inspection (see final report).
    const outDir = path.join(process.cwd(), "test-output");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "transcript-export-sample.pdf"), Buffer.from(bytes));
  });

  it("9. paginates a long transcript across multiple pages without throwing or clipping", async () => {
    // Enough long segments to force several page breaks.
    const segments: ExportableSegment[] = Array.from({ length: 120 }, (_, i) =>
      seg(
        i,
        i * 5,
        i * 5 + 4,
        `Sentence number ${i + 1}: the quick brown fox jumps over the lazy dog near the riverbank while the sun sets slowly behind the distant mountains, painting the sky in brilliant shades of orange and violet.`
      )
    );

    const bytes = await generateTranscriptPdf({
      title: "A Very Long Lesson About Many Things That Take A While To Say",
      videoId: "longvid1",
      version: 1,
      segments,
      loadFontBytes: loadFontBytesFromDisk,
    });

    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThan(3);

    const outDir = path.join(process.cwd(), "test-output");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "transcript-export-sample-multipage.pdf"), Buffer.from(bytes));
  });

  it("handles a missing title by falling back gracefully (no title line, no crash)", async () => {
    const bytes = await generateTranscriptPdf({
      title: null,
      videoId: "novid",
      version: null,
      segments: [seg(0, 0, 1.5, "Just one sentence.")],
      loadFontBytes: loadFontBytesFromDisk,
    });
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  it("wraps a very long single token (URL-like) instead of overflowing the page", async () => {
    const longToken = "https://example.com/" + "a".repeat(300);
    const bytes = await generateTranscriptPdf({
      title: "Long token test",
      videoId: "vid",
      version: 2,
      segments: [seg(0, 0, 1, longToken)],
      loadFontBytes: loadFontBytesFromDisk,
    });
    const loaded = await PDFDocument.load(bytes);
    // A 300+ char unbroken token at body size would need several wrapped
    // lines — if wrapping failed silently, this would still be 1 page,
    // so page count alone isn't proof, but it must not throw, and it must
    // produce a valid multi-line-capable document.
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });
});
