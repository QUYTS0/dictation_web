import { resolveResumeTarget, SEGMENT_START_PRE_ROLL_SEC } from "@/lib/utils/resumeTarget";
import type { TranscriptSegment } from "@/lib/types";

// Sentence i spans [2i, 2i+1.5) — i.e. with a 0.5s silent gap after each.
const segments: TranscriptSegment[] = Array.from({ length: 5 }, (_, i) => ({
  id: `s${i}`,
  transcript_id: "rev-A",
  segmentIndex: i,
  start: i * 2,
  end: i * 2 + 1.5,
  duration: 1.5,
  text: `Sentence ${i}.`,
  textNormalized: `sentence ${i}`,
}));

describe("resolveResumeTarget", () => {
  it("uses the saved playhead when it lies inside the checkpoint's own sentence", () => {
    expect(resolveResumeTarget(segments, 2, 4.7)).toEqual({ segmentIndex: 2, timeSec: 4.7, source: "saved_time" });
  });

  it("accepts the parked position just before the sentence (correct-answer auto-advance save)", () => {
    expect(resolveResumeTarget(segments, 2, 4 - SEGMENT_START_PRE_ROLL_SEC)?.source).toBe("saved_time");
  });

  it("accepts a Listening save in the silent gap after the sentence, before the next one starts", () => {
    expect(resolveResumeTarget(segments, 2, 5.8)?.source).toBe("saved_time");
  });

  it("falls back to the sentence start when the saved time is 0 (initialization default)", () => {
    expect(resolveResumeTarget(segments, 2, 0)).toEqual({ segmentIndex: 2, timeSec: 3.8, source: "sentence_start" });
  });

  it("falls back to the sentence start when the saved time belongs to a different sentence", () => {
    expect(resolveResumeTarget(segments, 2, 8.4)?.source).toBe("sentence_start");
    expect(resolveResumeTarget(segments, 2, 1.0)?.source).toBe("sentence_start");
  });

  it("rejects non-finite / missing saved times", () => {
    expect(resolveResumeTarget(segments, 2, Number.NaN)?.source).toBe("sentence_start");
    expect(resolveResumeTarget(segments, 2, null)?.source).toBe("sentence_start");
    expect(resolveResumeTarget(segments, 2, undefined)?.source).toBe("sentence_start");
  });

  it("clamps the sentence index (a completed round's index can equal the sentence count)", () => {
    expect(resolveResumeTarget(segments, 5, null)?.segmentIndex).toBe(4);
    expect(resolveResumeTarget(segments, -3, null)?.segmentIndex).toBe(0);
  });

  it("never seeks before 0 for the first sentence", () => {
    expect(resolveResumeTarget(segments, 0, null)?.timeSec).toBe(0);
  });

  it("returns null when there is no transcript to resolve against", () => {
    expect(resolveResumeTarget([], 0, 4)).toBeNull();
  });
});
