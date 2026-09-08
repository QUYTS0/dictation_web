import { analyzeTranscript } from "@/lib/vocabHighlights/winkPipeline";
import { generateSegmentCandidates } from "@/lib/vocabHighlights/candidates";

function candidatesFor(text: string) {
  const { bySegment, corroboratedPropnLemmas } = analyzeTranscript([{ segmentIndex: 0, text }]);
  const analysis = bySegment.get(0)!;
  return generateSegmentCandidates(analysis, corroboratedPropnLemmas);
}

describe("hyphen-compound candidate generation", () => {
  it("merges a two-part hyphenated compound into one word-kind candidate", () => {
    const candidates = candidatesFor("This is a meat-eating dilemma.");
    const compound = candidates.find((c) => c.originalText === "meat-eating");
    expect(compound).toBeDefined();
    expect(compound!.kind).toBe("word");
    expect(compound!.isHyphenCompound).toBe(true);
  });

  it("merges a longer hyphen chain (three segments)", () => {
    const candidates = candidatesFor("We need a state-of-the-art solution.");
    expect(candidates.some((c) => c.originalText === "state-of-the-art")).toBe(true);
  });

  it("does not merge across a spaced hyphen (a dash used as punctuation, not a compound)", () => {
    const candidates = candidatesFor("The result — surprising to everyone — was clear.");
    expect(candidates.some((c) => c.originalText.includes("result — surprising"))).toBe(false);
  });

  it("blocks a WordNet phrasal-verb match whose head token is glued to a preceding hyphen", () => {
    // "eat in" is a genuine WordNet phrasal verb; "meat-eating in" must not
    // treat "eating" as that verb's head, since it's the second half of a
    // hyphenated compound, not a finite/gerund verb taking "in" as its
    // particle.
    const candidates = candidatesFor("Vegetarianism is cheaper than meat-eating in most countries.");
    expect(candidates.some((c) => c.originalText.toLowerCase() === "eating in")).toBe(false);
  });
});

describe("named-entity policy for multi-word candidates", () => {
  it("tags an all-proper-noun WordNet MWE span as named-entity-suspected", () => {
    const candidates = candidatesFor("Members of the tribe live near the United States border.");
    const usEntity = candidates.find((c) => c.originalText === "United States");
    expect(usEntity).toBeDefined();
    expect(usEntity!.reasons).toContain("named-entity-suspected");
  });

  it("does not tag a non-proper-noun WordNet MWE", () => {
    const candidates = candidatesFor("The rebels decided to give up after months of fighting.");
    const giveUp = candidates.find((c) => c.originalText.toLowerCase() === "give up");
    expect(giveUp).toBeDefined();
    expect(giveUp!.reasons).not.toContain("named-entity-suspected");
  });
});

describe("supplementary phrase lexicon", () => {
  it("recognizes a curated fixed expression absent from WordNet/EFLLex", () => {
    const candidates = candidatesFor("Nothing changed — it was business as usual at the office.");
    const match = candidates.find((c) => c.originalText.toLowerCase() === "business as usual");
    expect(match).toBeDefined();
    expect(match!.sources).toContain("supplementary");
  });
});
