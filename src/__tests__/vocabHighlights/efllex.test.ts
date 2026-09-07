import { lookupEfllexWord, getEfllexMultiwordEntries, efllexVersion } from "@/lib/vocabHighlights/efllex";

describe("efllex", () => {
  it("resolves a known lemma", () => {
    const result = lookupEfllexWord("ubiquitous", "ADJ");
    expect(result).not.toBeNull();
    expect(result!.pos).toBe("JJ");
    expect(result!.estimatedLevel).toBe("B2");
  });

  it("uses POS to disambiguate a lemma with multiple EFLLex entries at different tags", () => {
    // "the" has separate EFLLex entries as a determiner (DT), a cardinal-ish
    // usage (CD), and a plain noun reading (NN) — each with very different
    // cumulative frequency curves.
    const asDeterminer = lookupEfllexWord("the", "DET");
    const asNumeral = lookupEfllexWord("the", "NUM");
    expect(asDeterminer?.pos).toBe("DT");
    expect(asDeterminer?.estimatedLevel).toBe("A1");
    expect(asNumeral?.pos).toBe("CD");
    expect(asNumeral?.estimatedLevel).toBe("B2");
  });

  it("falls back to the easiest available entry when the requested POS has no match", () => {
    const result = lookupEfllexWord("the", "INTJ");
    expect(result).not.toBeNull();
    expect(result!.pos).toBe("DT"); // easiest (A1) of the three available entries
  });

  it("returns null for a lemma absent from the dataset", () => {
    expect(lookupEfllexWord("destined", "NOUN")).toBeNull();
  });

  it("is deterministic given fixed inputs", () => {
    const a = lookupEfllexWord("ubiquitous", "ADJ");
    const b = lookupEfllexWord("ubiquitous", "ADJ");
    expect(a).toEqual(b);
  });

  it("matches multi-word EFLLex entries", () => {
    const entries = getEfllexMultiwordEntries();
    const accessRoad = entries.find((e) => e.lemma === "access road");
    expect(accessRoad).toBeDefined();
    expect(accessRoad!.wordCount).toBe(2);
  });

  it("exposes a stable dataset version string", () => {
    expect(efllexVersion()).toBe("efllex-2018-1");
  });
});
