import { resolveOverlaps } from "@/lib/vocabHighlights/overlap";
import type { HighlightCandidate } from "@/lib/vocabHighlights/types";

function candidate(partial: Partial<HighlightCandidate> & Pick<HighlightCandidate, "start" | "end" | "kind" | "score">): HighlightCandidate {
  return {
    segmentIndex: 0,
    originalText: "x",
    sources: ["subtlex"],
    reasons: [],
    ...partial,
  };
}

describe("overlap resolution", () => {
  it("a phrasal verb dominates its contained words: 'whisked away' beats 'whisked' and 'away' separately", () => {
    // "whisked away to another planet" — "whisked"=[0,7), " "=[7,8), "away"=[8,12)
    const whiskedAway = candidate({ start: 0, end: 12, kind: "phrasal_verb", score: 25, originalText: "whisked away" });
    const whisked = candidate({ start: 0, end: 7, kind: "word", score: 20, originalText: "whisked" });
    const away = candidate({ start: 8, end: 12, kind: "word", score: 0, originalText: "away" });

    const result = resolveOverlaps([whiskedAway, whisked, away]);
    expect(result).toHaveLength(1);
    expect(result[0].originalText).toBe("whisked away");
  });

  it("lets a genuinely rare word override a low-quality generic phrase that contains it (dominance override margin)", () => {
    const genericPhrase = candidate({ start: 0, end: 20, kind: "multiword_expression", score: 20, originalText: "generic phrase here" });
    const rareWord = candidate({ start: 8, end: 12, kind: "word", score: 90, originalText: "rare" });

    const result = resolveOverlaps([genericPhrase, rareWord]);
    expect(result).toHaveLength(1);
    expect(result[0].originalText).toBe("rare");
  });

  it("resolves same-tier nested phrases by score, not span length", () => {
    const longerLowerScore = candidate({ start: 0, end: 25, kind: "multiword_expression", score: 15, originalText: "climate change policy now" });
    const shorterHigherScore = candidate({ start: 0, end: 15, kind: "multiword_expression", score: 30, originalText: "climate change" });

    const result = resolveOverlaps([longerLowerScore, shorterHigherScore]);
    expect(result).toHaveLength(1);
    expect(result[0].originalText).toBe("climate change");
  });

  it("resolves two partially overlapping (non-containing) phrases deterministically by score", () => {
    const a = candidate({ start: 0, end: 10, kind: "multiword_expression", score: 25, originalText: "a" });
    const b = candidate({ start: 5, end: 15, kind: "multiword_expression", score: 40, originalText: "b" });

    const result = resolveOverlaps([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].originalText).toBe("b");
  });

  it("keeps every non-overlapping occurrence of a repeated phrase", () => {
    const first = candidate({ start: 0, end: 5, kind: "phrasal_verb", score: 25, originalText: "up up" });
    const second = candidate({ start: 20, end: 25, kind: "phrasal_verb", score: 25, originalText: "up up" });

    const result = resolveOverlaps([first, second]);
    expect(result).toHaveLength(2);
  });

  it("never includes both a phrase and a word fully contained within it", () => {
    const phrase = candidate({ start: 0, end: 10, kind: "idiom", score: 25, originalText: "idiom span" });
    const contained = candidate({ start: 2, end: 6, kind: "word", score: 5, originalText: "om s" });

    const result = resolveOverlaps([phrase, contained]);
    expect(result).toHaveLength(1);
    expect(result[0].originalText).toBe("idiom span");
  });
});
