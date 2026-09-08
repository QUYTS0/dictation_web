import { analyzeTranscript } from "@/lib/vocabHighlights/winkPipeline";
import { generateSegmentCandidates } from "@/lib/vocabHighlights/candidates";
import { expandConstructions } from "@/lib/vocabHighlights/constructions";

function expandFor(text: string) {
  const { bySegment, corroboratedPropnLemmas } = analyzeTranscript([{ segmentIndex: 0, text }]);
  const analysis = bySegment.get(0)!;
  const generated = generateSegmentCandidates(analysis, corroboratedPropnLemmas);
  return expandConstructions(analysis, generated);
}

describe("construction expansion — generalizes beyond the reported examples", () => {
  it("matches a verb-complement construction through a different inflection (responsible for)", () => {
    const expanded = expandFor("The manager is responsible for every decision made here.");
    const match = expanded.find((c) => c.originalText.toLowerCase() === "responsible for");
    expect(match).toBeDefined();
    expect(match!.canonicalForm).toBe("responsible for");
    expect(match!.kind).toBe("phrasal_verb");
  });

  it("matches the same verb-complement construction via passive/past-participle inflection (based on)", () => {
    const expanded = expandFor("The decision was based on new evidence.");
    expect(expanded.some((c) => c.originalText.toLowerCase() === "based on")).toBe(true);
  });

  it("does not fire a verb-complement construction when the required complement word is absent", () => {
    const expanded = expandFor("The team is responsible and diligent.");
    expect(expanded.some((c) => c.canonicalForm === "responsible for")).toBe(false);
  });

  it("expands an idiom with its complement marker only when the marker immediately follows", () => {
    const withMarker = expandFor("Cutting waste could go a long way toward solving the crisis.");
    expect(withMarker.some((c) => c.originalText.toLowerCase() === "go a long way toward")).toBe(true);

    const withoutMarker = expandFor("He said that would go a long way, honestly.");
    expect(withoutMarker.some((c) => c.originalText.toLowerCase().startsWith("go a long way "))).toBe(false);
  });

  it("matches the optional-internal-modifier construction with and without its infix", () => {
    const withInfix = expandFor("Crime dropped, thanks in part to better lighting.");
    expect(withInfix.some((c) => c.originalText.toLowerCase() === "thanks in part to")).toBe(true);

    const withoutInfix = expandFor("Crime dropped, thanks to better lighting.");
    expect(withoutInfix.some((c) => c.originalText.toLowerCase() === "thanks to")).toBe(true);
  });

  it("matches the elliptical comparative frame with a preceding quantity, and without one", () => {
    // The elliptical form ("as much/many as", with nothing between "much"/
    // "many" and the second "as") is the pattern this construction targets
    // — a full "as much [noun] as" frame with an explicit compared noun in
    // the middle is a materially different, harder-to-bound pattern and is
    // intentionally out of scope (see the final report's limitations).
    const withQuantity = expandFor("The new engine produces three times as much as the old one.");
    expect(withQuantity.some((c) => c.originalText.toLowerCase() === "three times as much as")).toBe(true);

    const bare = expandFor("She earns as much as her brother.");
    expect(bare.some((c) => c.originalText.toLowerCase() === "as much as")).toBe(true);
  });

  it("rejects the bare 'much as' fragment in favor of the full comparative frame span", () => {
    const expanded = expandFor("It weighs nearly ten times as much as expected.");
    const spans = expanded.map((c) => c.originalText.toLowerCase());
    expect(spans).toContain("ten times as much as");
  });

  it("matches quantifier constructions for a different quantity/scale pair", () => {
    const expanded = expandFor("Hundreds of thousands of volunteers joined the effort.");
    expect(expanded.some((c) => c.originalText.toLowerCase() === "hundreds of thousands")).toBe(true);
  });

  it("does not match a quantifier construction when the second word isn't a scale word", () => {
    const expanded = expandFor("Tens of people showed up.");
    expect(expanded).toHaveLength(0);
  });
});
