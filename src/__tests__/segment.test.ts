import {
  findSegmentIndexAtTime,
  getSegmentAtTime,
  getHint,
} from "@/lib/utils/segment";
import type { TranscriptSegment } from "@/lib/types";

function makeSegment(
  idx: number,
  start: number,
  end: number,
  text = "test"
): TranscriptSegment {
  return {
    id: String(idx),
    transcript_id: "t1",
    segmentIndex: idx,
    start,
    end,
    duration: end - start,
    text,
    textNormalized: text.toLowerCase(),
  };
}

const segments: TranscriptSegment[] = [
  makeSegment(0, 0, 5, "How are you doing today?"),
  makeSegment(1, 5, 10, "I am doing well thank you."),
  makeSegment(2, 10, 15, "That is great to hear."),
];

describe("findSegmentIndexAtTime", () => {
  it("finds the first segment at t=0", () => {
    expect(findSegmentIndexAtTime(segments, 0)).toBe(0);
  });

  it("finds the second segment at t=5", () => {
    expect(findSegmentIndexAtTime(segments, 5)).toBe(1);
  });

  it("finds the last segment at t=14", () => {
    expect(findSegmentIndexAtTime(segments, 14)).toBe(2);
  });

  it("returns -1 for time beyond last segment", () => {
    expect(findSegmentIndexAtTime(segments, 20)).toBe(-1);
  });

  it("returns -1 for empty segments", () => {
    expect(findSegmentIndexAtTime([], 5)).toBe(-1);
  });

  it("finds segment in mid range (binary search)", () => {
    const long = Array.from({ length: 100 }, (_, i) =>
      makeSegment(i, i * 3, i * 3 + 3)
    );
    expect(findSegmentIndexAtTime(long, 150)).toBe(50);
  });
});

describe("getSegmentAtTime", () => {
  it("returns the correct segment object", () => {
    const seg = getSegmentAtTime(segments, 7);
    expect(seg?.segmentIndex).toBe(1);
  });

  it("returns null for empty array", () => {
    expect(getSegmentAtTime([], 0)).toBeNull();
  });
});

describe("getHint", () => {
  const text = "How are you doing today?";

  it("level 0 returns empty hint", () => {
    expect(getHint(text, 0).hint).toBe("");
  });

  it("level 1 returns first letters", () => {
    const { hint } = getHint(text, 1);
    expect(hint.startsWith("H")).toBe(true);
    expect(hint).toContain("_");
  });

  it("level 2 returns word count", () => {
    expect(getHint(text, 2).hint).toBe("5 words");
  });

  it("level 4 returns full answer", () => {
    expect(getHint(text, 4).hint).toBe(text);
  });
});
