import { lookupSubtlex, subtlexUnknownBand } from "@/lib/vocabHighlights/subtlex";

describe("subtlex", () => {
  it("deprioritizes very common words", () => {
    const result = lookupSubtlex("the");
    expect(result).not.toBeNull();
    expect(result!.frequencyBand).toBe("very_common");
  });

  it("assigns an appropriate rare-word band", () => {
    const result = lookupSubtlex("ubiquitous");
    expect(result).not.toBeNull();
    expect(result!.frequencyBand).toBe("rare");
  });

  it("does not resolve a token that isn't in the dataset (unknown handled by caller, not auto-highlighted here)", () => {
    expect(lookupSubtlex("zzzxqplorpfake")).toBeNull();
  });

  it("exposes an explicit unknown-band fallback for callers to use after a null lookup", () => {
    expect(subtlexUnknownBand().frequencyBand).toBe("unknown");
  });

  it("is deterministic given fixed inputs", () => {
    expect(lookupSubtlex("away")).toEqual(lookupSubtlex("away"));
  });
});
