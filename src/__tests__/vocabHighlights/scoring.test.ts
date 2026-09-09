import { scoreCandidate } from "@/lib/vocabHighlights/scoring";
import { SCORING } from "@/lib/vocabHighlights/config";
import type { HighlightCandidate } from "@/lib/vocabHighlights/types";

function candidate(partial: Partial<HighlightCandidate> & Pick<HighlightCandidate, "kind" | "sources">): HighlightCandidate {
  return {
    segmentIndex: 0,
    start: 0,
    end: 5,
    originalText: "x",
    reasons: [],
    score: 0,
    ...partial,
  };
}

// Locks in the fix for the scoring side effect of canonicalForm propagation
// (candidates.ts now sets canonicalForm on plain WordNet/EFLLex/supplementary
// MWE matches, not just constructions.ts's output) — CONSTRUCTION_BONUS must
// be gated on provenance (sources including "construction"), never on
// canonicalForm's mere presence, or every one of those matches would start
// silently collecting a bonus they never had.
describe("scoring: CONSTRUCTION_BONUS provenance gating", () => {
  it("a construction-sourced candidate with canonicalForm set receives CONSTRUCTION_BONUS", () => {
    const c = candidate({ kind: "phrasal_verb", sources: ["construction"], canonicalForm: "pair with" });
    const scored = scoreCandidate(c, "B1");
    expect(scored.reasons).toContain("construction-bonus");
  });

  it("a WordNet-sourced MWE candidate with canonicalForm set does NOT receive CONSTRUCTION_BONUS", () => {
    const withoutCanonical = candidate({ kind: "phrasal_verb", sources: ["wordnet"] });
    const withCanonical = candidate({ kind: "phrasal_verb", sources: ["wordnet"], canonicalForm: "give up" });

    const scoredWithout = scoreCandidate(withoutCanonical, "B1");
    const scoredWith = scoreCandidate(withCanonical, "B1");

    expect(scoredWith.reasons).not.toContain("construction-bonus");
    // The only diff between these two candidates is the new canonicalForm
    // metadata field — score must be identical, proving the fix is
    // behavior-preserving for non-construction sources.
    expect(scoredWith.score).toBe(scoredWithout.score);
  });

  it("an EFLLex-sourced MWE candidate with canonicalForm set does NOT receive CONSTRUCTION_BONUS", () => {
    const c = candidate({ kind: "multiword_expression", sources: ["efllex"], canonicalForm: "as well as" });
    const scored = scoreCandidate(c, "B1");
    expect(scored.reasons).not.toContain("construction-bonus");
  });

  it("a supplementary-sourced MWE candidate with canonicalForm set does NOT receive CONSTRUCTION_BONUS", () => {
    const c = candidate({ kind: "idiom", sources: ["supplementary"], canonicalForm: "on the other hand" });
    const scored = scoreCandidate(c, "B1");
    expect(scored.reasons).not.toContain("construction-bonus");
  });

  it("a candidate sourced from multiple sources including construction still receives the bonus", () => {
    const c = candidate({ kind: "phrasal_verb", sources: ["wordnet", "construction"], canonicalForm: "give up" });
    const scored = scoreCandidate(c, "B1");
    expect(scored.reasons).toContain("construction-bonus");
  });

  it("the construction bonus amount is unchanged (still SCORING.CONSTRUCTION_BONUS)", () => {
    const c = candidate({ kind: "word", sources: ["construction"], canonicalForm: "x" });
    const scored = scoreCandidate(c, "B1");
    expect(scored.score).toBe(SCORING.CONSTRUCTION_BONUS);
  });
});
