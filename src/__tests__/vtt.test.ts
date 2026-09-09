import { parseVtt } from "@/lib/utils/vtt";

describe("parseVtt", () => {
  it("39. parses a standard WebVTT file with a header", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:00.000 --> 00:00:02.500",
      "Hello and welcome.",
      "",
      "2",
      "00:00:02.500 --> 00:00:05.000",
      "This is a test.",
      "",
    ].join("\n");

    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ text: "Hello and welcome.", offset: 0, duration: 2500 });
    expect(cues[1].text).toBe("This is a test.");
  });

  it("works without the optional WEBVTT header", () => {
    const vtt = "00:00:00.000 --> 00:00:01.000\nNo header here.";
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("No header here.");
  });

  it("supports MM:SS.mmm short-form timestamps", () => {
    const vtt = "WEBVTT\n\n00:07.000 --> 00:09.500\nShort form timestamp.";
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].offset).toBe(7000);
    expect(cues[0].duration).toBe(2500);
  });

  it("ignores NOTE/STYLE/REGION blocks", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE This is a comment block",
      "spanning two lines",
      "",
      "STYLE",
      "::cue { color: yellow; }",
      "",
      "00:00:00.000 --> 00:00:01.000",
      "Actual cue text.",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Actual cue text.");
  });

  it("strips cue markup (bold/italic/voice spans) without executing it, preserving text", () => {
    const vtt =
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<v Alex><b>Hello</b> <i>world</i> <script>alert(1)</script></v>';
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Hello world alert(1)");
  });

  it("preserves Unicode cue text", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nこんにちは — héllo — 😀";
    const cues = parseVtt(vtt);
    expect(cues[0].text).toBe("こんにちは — héllo — 😀");
  });

  it("ignores cue settings trailing the end timestamp", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000 align:start line:0%\nPositioned cue.";
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].duration).toBe(2000);
  });

  it("40. returns no cues for a malformed/empty file", () => {
    expect(parseVtt("WEBVTT\n\nthis is not a valid cue block")).toEqual([]);
    expect(parseVtt("")).toEqual([]);
  });

  it("skips a cue with an empty payload", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n\n00:00:01.000 --> 00:00:02.000\nReal text.";
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Real text.");
  });
});
