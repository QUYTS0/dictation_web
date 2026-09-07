import { selectFinalCandidates } from "@/lib/vocabHighlights/selection";
import type { HighlightCandidate } from "@/lib/vocabHighlights/types";

function candidate(partial: Partial<HighlightCandidate> & Pick<HighlightCandidate, "start" | "end" | "score">): HighlightCandidate {
  return {
    segmentIndex: 0,
    originalText: "x",
    kind: "word",
    sources: ["subtlex"],
    reasons: [],
    ...partial,
  };
}

describe("final selection density", () => {
  it("returns nothing when no candidate meets the minimum score threshold", () => {
    const text = "one two three four five";
    const weak = candidate({ start: 0, end: 3, score: 5, originalText: "one" });
    expect(selectFinalCandidates([weak], text)).toHaveLength(0);
  });

  it("respects MAX_HIGHLIGHTS_PER_SENTENCE (3)", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const words = text.split(" ");
    let offset = 0;
    const candidates = words.map((w) => {
      const start = text.indexOf(w, offset);
      offset = start + w.length;
      return candidate({ start, end: start + w.length, score: 50, originalText: w });
    });

    const result = selectFinalCandidates(candidates, text);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("enforces a minimum word distance between accepted highlights", () => {
    const text = "alpha beta gamma";
    const alpha = candidate({ start: 0, end: 5, score: 50, originalText: "alpha" });
    // "beta" is immediately adjacent to "alpha" with zero words between them.
    const beta = candidate({ start: 6, end: 10, score: 49, originalText: "beta" });

    const result = selectFinalCandidates([alpha, beta], text);
    expect(result).toHaveLength(1);
    expect(result[0].originalText).toBe("alpha");
  });

  it("is deterministic given fixed inputs", () => {
    const text = "alpha beta gamma";
    const candidates = [
      candidate({ start: 0, end: 5, score: 50, originalText: "alpha" }),
      candidate({ start: 12, end: 17, score: 30, originalText: "gamma" }),
    ];
    expect(selectFinalCandidates(candidates, text)).toEqual(selectFinalCandidates(candidates, text));
  });
});
