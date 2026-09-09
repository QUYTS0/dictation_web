import { normalizeVocabularyTerm, canonicalFormDiffersFromSurface } from "@/lib/utils/vocabulary";

describe("normalizeVocabularyTerm", () => {
  it("normalizes case and punctuation", () => {
    expect(normalizeVocabularyTerm("  Hello, WORLD! ")).toBe("hello world");
  });

  it("keeps apostrophes in words", () => {
    expect(normalizeVocabularyTerm("It's fine")).toBe("it's fine");
  });
});

describe("canonicalFormDiffersFromSurface", () => {
  it("is true when the canonical form is a different lemma phrase", () => {
    expect(canonicalFormDiffersFromSurface("give up", "given up")).toBe(true);
  });

  it("is false when there is no canonical form", () => {
    expect(canonicalFormDiffersFromSurface(undefined, "given up")).toBe(false);
    expect(canonicalFormDiffersFromSurface(null, "given up")).toBe(false);
    expect(canonicalFormDiffersFromSurface("", "given up")).toBe(false);
  });

  it("is false when the canonical form is the same as the surface term modulo case/punctuation", () => {
    expect(canonicalFormDiffersFromSurface("Give Up", "give up")).toBe(false);
    expect(canonicalFormDiffersFromSurface("go through", "go through!")).toBe(false);
  });
});
