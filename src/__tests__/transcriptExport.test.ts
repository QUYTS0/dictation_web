import {
  buildTranscriptTxt,
  buildTranscriptSrt,
  formatSrtTimestamp,
  validateSegmentsForSrt,
  sanitizeFilenameBase,
  buildExportFilename,
  type ExportableSegment,
} from "@/lib/utils/transcriptExport";
import { parseSrt } from "@/lib/utils/srt";

function seg(segmentIndex: number, start: number, end: number, text: string): ExportableSegment {
  return { segmentIndex, start, end, text };
}

describe("buildTranscriptTxt", () => {
  it("2. preserves the existing TXT behavior: one sentence per line, original order, no metadata", () => {
    const segments = [seg(0, 0, 1, "Hello there."), seg(1, 1, 2, "How are you?")];
    expect(buildTranscriptTxt(segments)).toBe("Hello there.\nHow are you?");
  });

  it("includes Vietnamese text unchanged", () => {
    const segments = [seg(0, 0, 1, "Xin chào, đây là một câu tiếng Việt.")];
    expect(buildTranscriptTxt(segments)).toBe("Xin chào, đây là một câu tiếng Việt.");
  });

  it("returns an empty string for no segments", () => {
    expect(buildTranscriptTxt([])).toBe("");
  });
});

describe("formatSrtTimestamp", () => {
  it("3. formats a simple sub-minute time", () => {
    expect(formatSrtTimestamp(1.25)).toBe("00:00:01,250");
  });

  it("3. formats an exact whole-second time with zero milliseconds", () => {
    expect(formatSrtTimestamp(5)).toBe("00:00:05,000");
  });

  it("4. rolls milliseconds over into seconds at the boundary", () => {
    expect(formatSrtTimestamp(59.999)).toBe("00:00:59,999");
    expect(formatSrtTimestamp(60)).toBe("00:01:00,000");
  });

  it("4. rolls seconds over into minutes at the boundary", () => {
    expect(formatSrtTimestamp(119.5)).toBe("00:01:59,500");
    expect(formatSrtTimestamp(120)).toBe("00:02:00,000");
  });

  it("4. rolls minutes over into hours at the boundary", () => {
    expect(formatSrtTimestamp(3599.999)).toBe("00:59:59,999");
    expect(formatSrtTimestamp(3600)).toBe("01:00:00,000");
  });

  it("4. handles a long lesson spanning multiple hours", () => {
    expect(formatSrtTimestamp(7384.125)).toBe("02:03:04,125");
  });

  it("rounds fractional milliseconds to the nearest integer millisecond", () => {
    // 1.2345s -> 1234.5ms -> rounds to 1235ms (not truncated to 1234).
    expect(formatSrtTimestamp(1.2345)).toBe("00:00:01,235");
  });
});

describe("validateSegmentsForSrt / buildTranscriptSrt", () => {
  it("3. produces sequential numbering, blank-line separation, and HH:MM:SS,mmm --> HH:MM:SS,mmm timestamps", () => {
    const segments = [seg(0, 1.25, 4.8, "This is an example."), seg(1, 5, 8.5, "This is another sentence.")];
    const srt = buildTranscriptSrt(segments);
    expect(srt).toBe(
      "1\n00:00:01,250 --> 00:00:04,800\nThis is an example.\n\n2\n00:00:05,000 --> 00:00:08,500\nThis is another sentence.\n"
    );
  });

  it("3. preserves meaningful punctuation in cue text", () => {
    const segments = [seg(0, 0, 1, "Wait—really? “Yes,” she said.")];
    const srt = buildTranscriptSrt(segments);
    expect(srt).toContain("Wait—really? “Yes,” she said.");
  });

  it("5. exports source text only — no UI annotations, translations, or headings inside cues", () => {
    const segments = [seg(0, 0, 1, "Plain source text.")];
    const srt = buildTranscriptSrt(segments);
    expect(srt).not.toMatch(/translation|source:|http/i);
    expect(srt.split("\n").filter((l) => l.trim().length > 0 && !/^\d+$/.test(l) && !l.includes("-->"))).toEqual([
      "Plain source text.",
    ]);
  });

  it("does not rewrite valid gaps or overlaps between cues", () => {
    // A real gap (cue 2 starts well after cue 1 ends) and a real overlap
    // (cue 3 starts before cue 2 ends) must both pass through unchanged —
    // only each cue's own start/end validity is checked.
    const segments = [seg(0, 0, 1, "A"), seg(1, 5, 6, "B"), seg(2, 5.5, 7, "C")];
    const srt = buildTranscriptSrt(segments);
    expect(srt).toContain("00:00:00,000 --> 00:00:01,000");
    expect(srt).toContain("00:00:05,000 --> 00:00:06,000");
    expect(srt).toContain("00:00:05,500 --> 00:00:07,000");
  });

  it("4. rejects segments with missing/non-finite timing rather than inventing it", () => {
    const segments = [seg(0, 0, 1, "OK"), seg(1, NaN, 2, "Broken")];
    const validation = validateSegmentsForSrt(segments);
    expect(validation.ok).toBe(false);
    expect(validation.reason).toMatch(/timing/i);
    expect(() => buildTranscriptSrt(segments)).toThrow(/timing/i);
  });

  it("4. rejects negative timestamps", () => {
    const segments = [seg(0, -1, 2, "Negative start")];
    expect(validateSegmentsForSrt(segments).ok).toBe(false);
  });

  it("4. rejects zero or negative cue duration", () => {
    expect(validateSegmentsForSrt([seg(0, 2, 2, "Zero duration")]).ok).toBe(false);
    expect(validateSegmentsForSrt([seg(0, 3, 2, "Negative duration")]).ok).toBe(false);
  });

  it("rejects an empty segment list", () => {
    expect(validateSegmentsForSrt([]).ok).toBe(false);
  });
});

// parseSrt() itself is verified below to read back exactly the cues
// buildTranscriptSrt() wrote (offset/duration/text, 1:1). What this does
// NOT verify — and what is not claimed anywhere in this change — is a
// full round trip through the app's downstream mergeIntoSentences()
// pipeline (used by the manual-paste/.srt-upload flow, see
// useSrtTranscriptUpload.ts), which groups adjacent short cues into
// sentences using its own heuristics; re-importing an exported .srt is
// therefore not guaranteed to reproduce the original segment boundaries,
// segment count, or content-fingerprint one-to-one.
describe("SRT import compatibility (src/lib/utils/srt.ts's parseSrt)", () => {
  it("round-trips cue offset/duration/text exactly through the app's own .srt importer", () => {
    const segments = [
      seg(0, 1.25, 4.8, "This is an example."),
      seg(1, 5, 8.5, "This is another sentence, with a comma."),
      seg(2, 10.001, 12.75, "Xin chào, đây là câu tiếng Việt."),
    ];
    const srt = buildTranscriptSrt(segments);
    const cues = parseSrt(srt);

    expect(cues).toHaveLength(segments.length);
    segments.forEach((s, i) => {
      // parseSrt reports offset/duration in milliseconds — compare against
      // the same millisecond rounding buildTranscriptSrt itself applies,
      // not the raw float seconds (a true byte-for-byte fingerprint round
      // trip isn't claimed or required here — only that the parser reads
      // back the same cues buildTranscriptSrt wrote).
      expect(cues[i].offset).toBe(Math.round(s.start * 1000));
      expect(cues[i].duration).toBe(Math.round(s.end * 1000) - Math.round(s.start * 1000));
      expect(cues[i].text).toBe(s.text);
    });
  });
});

describe("sanitizeFilenameBase", () => {
  it("8. strips reserved/unsafe filename characters", () => {
    expect(sanitizeFilenameBase('My:Video/Name*?"<>|')).toBe("My Video Name");
  });

  it("8. preserves Unicode letters (Vietnamese diacritics) unlike the old ASCII-only filter", () => {
    expect(sanitizeFilenameBase("Học Tiếng Anh: Bài 1")).toBe("Học Tiếng Anh Bài 1");
  });

  it("8. trims trailing dots and spaces (invalid on Windows)", () => {
    expect(sanitizeFilenameBase("My Video...  ")).toBe("My Video");
  });

  it("collapses internal whitespace runs", () => {
    expect(sanitizeFilenameBase("A   lot   of   spaces")).toBe("A lot of spaces");
  });
});

describe("buildExportFilename", () => {
  it("8. produces the expected extension per format", () => {
    expect(buildExportFilename("txt", { title: "My Video", videoId: "abc" })).toBe("My Video.txt");
    expect(buildExportFilename("srt", { title: "My Video", videoId: "abc" })).toBe("My Video.srt");
    expect(buildExportFilename("pdf", { title: "My Video", videoId: "abc" })).toBe("My Video.pdf");
  });

  it("8. falls back to a video-id-based name when the title is unavailable", () => {
    expect(buildExportFilename("txt", { title: null, videoId: "abc123" })).toBe("video-abc123.txt");
    expect(buildExportFilename("txt", { title: "   ", videoId: "abc123" })).toBe("video-abc123.txt");
  });

  it("includes the real revision version when known, never a fabricated one", () => {
    expect(buildExportFilename("txt", { title: "My Video", videoId: "abc", version: 3 })).toBe("My Video-v3.txt");
    expect(buildExportFilename("txt", { title: "My Video", videoId: "abc", version: null })).toBe("My Video.txt");
    expect(buildExportFilename("txt", { title: "My Video", videoId: "abc" })).toBe("My Video.txt");
  });
});
