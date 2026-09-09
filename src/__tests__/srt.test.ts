import { parseSrt } from "@/lib/utils/srt";

describe("parseSrt", () => {
  it("38. parses a standard .srt file into cues with millisecond offsets/durations", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:02,500",
      "Hello and welcome.",
      "",
      "2",
      "00:00:02,500 --> 00:00:05,000",
      "This is a test.",
      "",
    ].join("\n");

    const cues = parseSrt(srt);
    expect(cues).toEqual([
      { text: "Hello and welcome.", offset: 0, duration: 2500 },
      { text: "This is a test.", offset: 2500, duration: 2500 },
    ]);
  });

  it("strips formatting tags without executing them", () => {
    const srt = "1\n00:00:00,000 --> 00:00:01,000\n<b>Bold</b> and <script>alert(1)</script> text";
    const cues = parseSrt(srt);
    expect(cues[0].text).toBe("Bold and alert(1) text");
  });

  it("skips a block with a malformed/reversed timestamp", () => {
    const srt = "1\n00:00:05,000 --> 00:00:01,000\nReversed.\n\n2\n00:00:01,000 --> 00:00:03,000\nGood cue.";
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Good cue.");
  });

  it("40. returns an empty array for a malformed/empty file", () => {
    expect(parseSrt("not an srt file at all")).toEqual([]);
    expect(parseSrt("")).toEqual([]);
  });

  it("handles a UTF-8 BOM and Unicode text", () => {
    const srt = "﻿1\n00:00:00,000 --> 00:00:01,000\nこんにちは — héllo";
    const cues = parseSrt(srt);
    expect(cues[0].text).toBe("こんにちは — héllo");
  });
});
