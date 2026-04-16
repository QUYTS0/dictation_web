import { normalizeVocabularyTerm } from "@/lib/utils/vocabulary";

describe("normalizeVocabularyTerm", () => {
  it("normalizes case and punctuation", () => {
    expect(normalizeVocabularyTerm("  Hello, WORLD! ")).toBe("hello world");
  });

  it("keeps apostrophes in words", () => {
    expect(normalizeVocabularyTerm("It's fine")).toBe("it's fine");
  });
});
