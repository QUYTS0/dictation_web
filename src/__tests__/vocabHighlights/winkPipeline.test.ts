import { analyzeTranscript, isConfidentProperNoun } from "@/lib/vocabHighlights/winkPipeline";

describe("winkPipeline offsets", () => {
  it("reconstructs exact offsets for every token, including contractions/possessives/hyphens/quotes/dashes", () => {
    const text = "They aren't ready—it's a 24-hour café, don't you think?";
    const { bySegment } = analyzeTranscript([{ segmentIndex: 0, text }]);
    const tokens = bySegment.get(0)!.tokens;
    for (const t of tokens) {
      expect(text.slice(t.start, t.end)).toBe(t.text);
    }
  });

  it("reconstructs exact offsets for curly quotes and em dashes", () => {
    const text = "She said ‘hello’ and “goodbye” quickly—now.";
    const { bySegment } = analyzeTranscript([{ segmentIndex: 0, text }]);
    const tokens = bySegment.get(0)!.tokens;
    for (const t of tokens) {
      expect(text.slice(t.start, t.end)).toBe(t.text);
    }
  });

  it("excludes leading/trailing punctuation from token spans", () => {
    const text = "Hello, world!";
    const { bySegment } = analyzeTranscript([{ segmentIndex: 0, text }]);
    const tokens = bySegment.get(0)!.tokens;
    expect(tokens.find((t) => t.text === ",")).toBeDefined();
    expect(tokens.find((t) => t.text === "Hello,")).toBeUndefined();
  });

  it("lemmatizes common inflections", () => {
    const text = "The universe expands rapidly. New emissions targets were announced.";
    const { bySegment } = analyzeTranscript([{ segmentIndex: 0, text }]);
    const tokens = bySegment.get(0)!.tokens;
    expect(tokens.find((t) => t.text === "expands")?.lemma).toBe("expand");
    expect(tokens.find((t) => t.text === "emissions")?.lemma).toBe("emission");
  });

  it("does not automatically treat every sentence-initial capitalized word as a confident proper noun", () => {
    const text = "Farm animals destined for food vanish.";
    const { bySegment, corroboratedPropnLemmas } = analyzeTranscript([{ segmentIndex: 0, text }]);
    const tokens = bySegment.get(0)!.tokens;
    const farm = tokens[0];
    expect(farm.text).toBe("Farm");
    // winkNLP's POS tagger does mistag this sentence-initial common noun as
    // PROPN — the corroboration check is what keeps it from being treated
    // as a confident proper noun with no other evidence.
    expect(isConfidentProperNoun(farm, true, corroboratedPropnLemmas)).toBe(false);
  });

  it("treats a PROPN-tagged token as confident when corroborated elsewhere in the transcript at a non-initial position", () => {
    const segments = [
      { segmentIndex: 0, text: "Sarah walked into the room." },
      { segmentIndex: 1, text: "Everyone greeted Sarah warmly." },
    ];
    const { bySegment, corroboratedPropnLemmas } = analyzeTranscript(segments);
    const firstSarah = bySegment.get(0)!.tokens[0];
    expect(firstSarah.text).toBe("Sarah");
    expect(isConfidentProperNoun(firstSarah, true, corroboratedPropnLemmas)).toBe(true);
  });

  it("hard-excludes pattern-based entities (URL/email/date) as spans", () => {
    const text = "Email me at test@example.com by 12/05/2026.";
    const { bySegment } = analyzeTranscript([{ segmentIndex: 0, text }]);
    const spans = bySegment.get(0)!.hardExcludedSpans;
    expect(spans.some((s) => text.slice(s.start, s.end) === "test@example.com")).toBe(true);
  });
});
