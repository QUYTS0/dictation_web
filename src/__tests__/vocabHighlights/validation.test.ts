import { analyzeTranscript } from "@/lib/vocabHighlights/winkPipeline";
import { validateLocalCandidates, isAzurePhraseBoundaryValid, isPossessiveCliticText } from "@/lib/vocabHighlights/validation";
import type { HighlightCandidate } from "@/lib/vocabHighlights/types";

function candidate(partial: Partial<HighlightCandidate> & Pick<HighlightCandidate, "start" | "end" | "originalText">): HighlightCandidate {
  return {
    segmentIndex: 0,
    kind: "word",
    sources: ["subtlex"],
    reasons: [],
    score: 0,
    ...partial,
  };
}

describe("isPossessiveCliticText", () => {
  it.each(["'s", "’s", "s'", "s’"])("recognizes %s as a bare possessive clitic", (text) => {
    expect(isPossessiveCliticText(text)).toBe(true);
  });

  it("does not flag an ordinary word", () => {
    expect(isPossessiveCliticText("world")).toBe(false);
  });
});

describe("validateLocalCandidates", () => {
  const text = "The world's calories come mostly from wheat, rice, and corn.";
  const { bySegment } = analyzeTranscript([{ segmentIndex: 0, text }]);
  const analysis = bySegment.get(0)!;

  it("rejects a punctuation-only candidate", () => {
    const c = candidate({ start: 0, end: 1, originalText: "," });
    expect(validateLocalCandidates([c], analysis)).toHaveLength(0);
  });

  it("rejects a bare possessive-clitic candidate", () => {
    const c = candidate({ start: 9, end: 11, originalText: "'s" });
    expect(validateLocalCandidates([c], analysis)).toHaveLength(0);
  });

  it("rejects a single-token candidate whose POS is a pure function word", () => {
    const c = candidate({ start: 0, end: 3, originalText: "The", pos: "DET", kind: "word" });
    expect(validateLocalCandidates([c], analysis)).toHaveLength(0);
  });

  it("rejects a candidate with leading or trailing punctuation in its text", () => {
    const c = candidate({ start: 0, end: 5, originalText: ", abc" });
    expect(validateLocalCandidates([c], analysis)).toHaveLength(0);
  });

  it("rejects an out-of-range span", () => {
    const c = candidate({ start: -1, end: 5, originalText: "abcde" });
    expect(validateLocalCandidates([c], analysis)).toHaveLength(0);
  });

  it("deduplicates an exact-duplicate span", () => {
    const c1 = candidate({ start: 4, end: 9, originalText: "world", pos: "NOUN" });
    const c2 = candidate({ start: 4, end: 9, originalText: "world", pos: "NOUN" });
    expect(validateLocalCandidates([c1, c2], analysis)).toHaveLength(1);
  });

  it("keeps a legitimate multi-word candidate untouched", () => {
    const c = candidate({ start: 4, end: 20, originalText: "world's calories", kind: "multiword_expression" });
    expect(validateLocalCandidates([c], analysis)).toHaveLength(1);
  });
});

describe("isAzurePhraseBoundaryValid", () => {
  const text = "Vegetarianism becomes less expensive than meat-eating in most countries.";
  const { bySegment } = analyzeTranscript([{ segmentIndex: 0, text }]);
  const analysis = bySegment.get(0)!;

  it("rejects an Azure phrase ending in a bare preposition", () => {
    const start = text.indexOf("meat-eating in");
    const c = candidate({ start, end: start + "meat-eating in".length, originalText: "meat-eating in", kind: "topic_phrase" });
    expect(isAzurePhraseBoundaryValid(c, analysis)).toBe(false);
  });

  it("accepts an Azure phrase that ends in a content word", () => {
    const start = text.indexOf("meat-eating");
    const c = candidate({ start, end: start + "meat-eating".length, originalText: "meat-eating", kind: "topic_phrase" });
    expect(isAzurePhraseBoundaryValid(c, analysis)).toBe(true);
  });
});
