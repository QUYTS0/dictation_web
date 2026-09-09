import { parseTimestampedPaste } from "@/lib/utils/timestampPaste";

describe("parseTimestampedPaste", () => {
  it("falls back to not_timestamped for plain prose", () => {
    const result = parseTimestampedPaste("How are you doing today? I am doing well. That is great.");
    expect(result.kind).toBe("not_timestamped");
  });

  it("35. parses timestamp-on-its-own-line format", () => {
    const text = "0:07\nLet's explore a hypothetical together.\n\n0:09\nThere are over four times as many livestock as people.";
    const result = parseTimestampedPaste(text);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0]).toMatchObject({ start: 7, text: "Let's explore a hypothetical together." });
      expect(result.segments[0].end).toBe(9);
      expect(result.segments[1].text).toBe("There are over four times as many livestock as people.");
    }
  });

  it("36. parses timestamp-and-text-on-the-same-line format", () => {
    const text = "0:07 Let's explore a hypothetical together.\n0:09 There are over four times as many livestock as people.";
    const result = parseTimestampedPaste(text);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0].start).toBe(7);
      expect(result.segments[1].start).toBe(9);
    }
  });

  it("37. supports multiline cue text between timestamps", () => {
    const text = "0:07\nLet's explore\na hypothetical\ntogether.\n\n0:12\nNext sentence.";
    const result = parseTimestampedPaste(text);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.segments[0].text).toBe("Let's explore a hypothetical together.");
      expect(result.segments[0].end).toBe(12);
    }
  });

  it("supports bracketed and HH:MM:SS timestamps", () => {
    const text = "[00:07] Bracketed cue text.\n1:02:15 An hour-plus timestamp.";
    const result = parseTimestampedPaste(text);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.segments[0].start).toBe(7);
      expect(result.segments[1].start).toBe(1 * 3600 + 2 * 60 + 15);
    }
  });

  it("40. rejects decreasing timestamps with a clear error message", () => {
    const text = "0:30 Second in time.\n0:05 First in time.";
    const result = parseTimestampedPaste(text);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/timestamp/i);
    }
  });

  it("does not interpret an arbitrary number embedded mid-sentence as a timestamp", () => {
    const text = "I woke up at 7:45 and went for a run before breakfast, which was nice.";
    const result = parseTimestampedPaste(text);
    expect(result.kind).toBe("not_timestamped");
  });

  it("uses a known video duration for the final cue's end time", () => {
    const text = "0:07 Only one cue here.";
    const result = parseTimestampedPaste(text, { videoDurationSec: 42 });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.segments[0].end).toBe(42);
    }
  });

  it("falls back to a word-count-based estimate for the final cue when no duration is known", () => {
    const text = "0:07 A short final cue with several words in it.";
    const result = parseTimestampedPaste(text);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.segments[0].end).toBeGreaterThan(7);
    }
  });

  it("assigns sequential segmentIndex values", () => {
    const text = "0:00 First.\n0:02 Second.\n0:04 Third.";
    const result = parseTimestampedPaste(text);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.segments.map((s) => s.segmentIndex)).toEqual([0, 1, 2]);
    }
  });
});
