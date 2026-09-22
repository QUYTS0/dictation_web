import { computeTranscriptFingerprint, type FingerprintableSegment } from "@/lib/utils/transcriptFingerprint";

function seg(segmentIndex: number, start: number, end: number, text: string): FingerprintableSegment {
  return { segmentIndex, start, end, text };
}

describe("computeTranscriptFingerprint", () => {
  it("is deterministic for identical input", () => {
    const segments = [seg(0, 0, 2, "Hello world."), seg(1, 2, 4, "How are you?")];
    expect(computeTranscriptFingerprint(segments)).toBe(computeTranscriptFingerprint(segments));
  });

  it("is unaffected by input array order — segments are re-sorted by segmentIndex before hashing", () => {
    const inOrder = [seg(0, 0, 2, "Hello world."), seg(1, 2, 4, "How are you?")];
    const reversed = [seg(1, 2, 4, "How are you?"), seg(0, 0, 2, "Hello world.")];
    expect(computeTranscriptFingerprint(inOrder)).toBe(computeTranscriptFingerprint(reversed));
  });

  it("tolerates sub-0.1s floating-point timing jitter", () => {
    const a = [seg(0, 0.0001, 1.9999, "Hello world.")];
    const b = [seg(0, 0, 2, "Hello world.")];
    expect(computeTranscriptFingerprint(a)).toBe(computeTranscriptFingerprint(b));
  });

  it("changes when a segment's text meaningfully changes", () => {
    const a = [seg(0, 0, 2, "Hello world.")];
    const b = [seg(0, 0, 2, "Goodbye world.")];
    expect(computeTranscriptFingerprint(a)).not.toBe(computeTranscriptFingerprint(b));
  });

  it("changes when timing shifts by more than the rounding step", () => {
    const a = [seg(0, 0, 2, "Hello world.")];
    const b = [seg(0, 0.5, 2.5, "Hello world.")];
    expect(computeTranscriptFingerprint(a)).not.toBe(computeTranscriptFingerprint(b));
  });

  it("changes when segment boundaries (count) change even if joined text reads the same", () => {
    const oneSegment = [seg(0, 0, 4, "Hello world how are you")];
    const twoSegments = [seg(0, 0, 2, "Hello world"), seg(1, 2, 4, "how are you")];
    expect(computeTranscriptFingerprint(oneSegment)).not.toBe(computeTranscriptFingerprint(twoSegments));
  });

  it("is insensitive to case/punctuation, matching the relaxed normalization used for storage", () => {
    const a = [seg(0, 0, 2, "Hello, World!")];
    const b = [seg(0, 0, 2, "hello world")];
    expect(computeTranscriptFingerprint(a)).toBe(computeTranscriptFingerprint(b));
  });
});
