import { analyzeTranscript } from "@/lib/vocabHighlights/winkPipeline";
import { generateSegmentCandidates, computeWindowLengths, MAX_SAFE_MWE_TOKENS } from "@/lib/vocabHighlights/candidates";
import { SUPPLEMENTARY_PHRASES } from "@/lib/vocabHighlights/supplementaryPhrases";

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

// canonicalForm propagation (Phase A1): a WordNet/EFLLex/supplementary MWE
// match's joined lemma IS already the canonical form — this locks in that it
// now reaches the candidate, not just the internal `lemma` field.
describe("canonicalForm propagation on lexicon-sourced MWE matches", () => {
  it("sets canonicalForm to the matched lemma phrase for a WordNet phrasal verb", () => {
    const candidates = candidatesFor("The rebels decided to give up after months of fighting.");
    const giveUp = candidates.find((c) => c.originalText.toLowerCase() === "give up");
    expect(giveUp?.canonicalForm).toBe("give up");
  });

  it("canonicalizes an inflected surface form to the base lemma phrase", () => {
    const candidates = candidatesFor("He has given up.");
    const givenUp = candidates.find((c) => c.originalText.toLowerCase() === "given up");
    expect(givenUp?.canonicalForm).toBe("give up");
  });

  it("sets canonicalForm for a supplementary-sourced match too", () => {
    const candidates = candidatesFor("Nothing changed — it was business as usual at the office.");
    const match = candidates.find((c) => c.originalText.toLowerCase() === "business as usual");
    expect(match?.canonicalForm).toBe("business as usual");
  });
});

// Dynamic phrase-window length (Phase A1): replaces the old fixed
// MWE_WINDOW_LENGTHS = [4,3,2], which made any lexicon entry longer than 4
// tokens unreachable.
describe("dynamic MWE window length", () => {
  it("matches a 6-token supplementary entry ('at the end of the day') that the old fixed [4,3,2] window could never reach", () => {
    const candidates = candidatesFor("We should remember, at the end of the day, everyone wants the same thing.");
    const match = candidates.find((c) => c.originalText.toLowerCase() === "at the end of the day");
    expect(match).toBeDefined();
    expect(match?.sources).toContain("supplementary");
    expect(match?.canonicalForm).toBe("at the end of the day");
  });

  it("every SUPPLEMENTARY_PHRASES entry is within the safety cap (guards against silently-dead future entries)", () => {
    for (const key of Object.keys(SUPPLEMENTARY_PHRASES)) {
      expect(key.split(" ").length).toBeLessThanOrEqual(MAX_SAFE_MWE_TOKENS);
    }
  });
});

describe("computeWindowLengths (pure window-sizing logic)", () => {
  it("produces a descending sequence down to 2 for a given max", () => {
    expect(computeWindowLengths([4])).toEqual([4, 3, 2]);
    expect(computeWindowLengths([6])).toEqual([6, 5, 4, 3, 2]);
  });

  it("takes the max across multiple sources", () => {
    expect(computeWindowLengths([4, 4, 6])).toEqual([6, 5, 4, 3, 2]);
  });

  it("clamps to MAX_SAFE_MWE_TOKENS even if a source reports a longer entry", () => {
    const lengths = computeWindowLengths([4, 4, 20]);
    expect(lengths[0]).toBe(MAX_SAFE_MWE_TOKENS);
    expect(lengths).toEqual(
      Array.from({ length: MAX_SAFE_MWE_TOKENS - 1 }, (_, i) => MAX_SAFE_MWE_TOKENS - i)
    );
  });

  it("never produces a window shorter than 2", () => {
    expect(computeWindowLengths([0])).toEqual([]);
    expect(computeWindowLengths([1])).toEqual([]);
  });
});
