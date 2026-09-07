import { lookupWordnetMultiword, wordnetVersion } from "@/lib/vocabHighlights/wordnet";

describe("wordnet", () => {
  it("detects a known phrasal verb", () => {
    const result = lookupWordnetMultiword("whisk away");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("phrasal_verb");
  });

  it("detects a generic multi-word expression as multiword_expression, not phrasal_verb", () => {
    const result = lookupWordnetMultiword("access road");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("multiword_expression");
  });

  it("returns null for a phrase not in the index", () => {
    expect(lookupWordnetMultiword("zzz not a real phrase")).toBeNull();
  });

  it("exposes a stable dataset version string", () => {
    expect(wordnetVersion()).toBe("oewn-2025-edition");
  });
});
