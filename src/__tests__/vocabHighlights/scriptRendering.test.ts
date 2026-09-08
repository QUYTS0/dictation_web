import { buildScriptRenderItems, findHighlightPhrase } from "@/app/dictation/[videoId]/helpers";
import type { VocabHighlightPhrase } from "@/lib/types";

describe("buildScriptRenderItems with offset-based phrases", () => {
  it("highlights every occurrence of a repeated phrase when offsets are provided (fixes the legacy first-match-only bug)", () => {
    const text = "He decided to give up. Later, she also decided to give up.";
    const firstIdx = text.toLowerCase().indexOf("give up");
    const secondIdx = text.toLowerCase().indexOf("give up", firstIdx + 1);
    const phrases: VocabHighlightPhrase[] = [
      { phrase: "give up", translation: null, start: firstIdx, end: firstIdx + 7 },
      { phrase: "give up", translation: null, start: secondIdx, end: secondIdx + 7 },
    ];

    const items = buildScriptRenderItems(text, phrases);
    const phraseItems = items.filter((i) => i.kind === "phrase");
    expect(phraseItems).toHaveLength(2);
    expect(phraseItems.every((i) => i.text.toLowerCase() === "give up")).toBe(true);
  });

  it("still falls back to first-occurrence substring search for a legacy phrase with no offsets", () => {
    const text = "He decided to give up. Later, she also decided to give up.";
    const phrases: VocabHighlightPhrase[] = [{ phrase: "give up", translation: null }];

    const items = buildScriptRenderItems(text, phrases);
    const phraseItems = items.filter((i) => i.kind === "phrase");
    expect(phraseItems).toHaveLength(1);
  });

  it("excludes surrounding punctuation from the highlighted phrase item", () => {
    const text = "Farm animals destined for food vanish—whisked away to another planet.";
    const start = text.indexOf("whisked away");
    const phrases: VocabHighlightPhrase[] = [{ phrase: "whisked away", translation: null, start, end: start + "whisked away".length }];

    const items = buildScriptRenderItems(text, phrases);
    const phraseItems = items.filter((i) => i.kind === "phrase");
    expect(phraseItems.some((i) => /[.,!?;:]/.test(i.text))).toBe(false);
  });

  it("ignores an out-of-range offset pair rather than crashing", () => {
    const text = "short text";
    const phrases: VocabHighlightPhrase[] = [{ phrase: "bogus", translation: null, start: 500, end: 600 }];
    expect(() => buildScriptRenderItems(text, phrases)).not.toThrow();
  });
});

// findHighlightPhrase is what the click-to-save popover and the hover/tap
// tooltip both use to recover a clicked highlight's full metadata (including
// canonicalForm/learningPattern) from plain selected text — this is the exact
// lookup that closes the gap between the highlights query (which always has
// the metadata) and the popover state (which previously discarded it).
describe("findHighlightPhrase", () => {
  const phrases: VocabHighlightPhrase[] = [
    {
      phrase: "go a long way toward",
      translation: "góp phần rất lớn vào",
      start: 0,
      end: 21,
      canonicalForm: "go a long way",
      learningPattern: "go a long way toward(s) + noun/V-ing",
    },
    { phrase: "meat-eating", translation: "ăn thịt", start: 30, end: 41 },
  ];

  it("returns the full highlight object, including canonicalForm/learningPattern, for an exact match", () => {
    const match = findHighlightPhrase(phrases, "go a long way toward");
    expect(match?.canonicalForm).toBe("go a long way");
    expect(match?.learningPattern).toBe("go a long way toward(s) + noun/V-ing");
    expect(match?.translation).toBe("góp phần rất lớn vào");
  });

  it("matches case- and whitespace-insensitively, as a real DOM selection would produce", () => {
    const match = findHighlightPhrase(phrases, "  GO A LONG WAY TOWARD  ");
    expect(match?.learningPattern).toBe("go a long way toward(s) + noun/V-ing");
  });

  it("returns undefined (not a placeholder) for a highlight with no learningPattern", () => {
    const match = findHighlightPhrase(phrases, "meat-eating");
    expect(match).toBeDefined();
    expect(match?.learningPattern).toBeUndefined();
  });

  it("returns undefined for text that matches no highlight (free-form selection)", () => {
    expect(findHighlightPhrase(phrases, "some unrelated selection")).toBeUndefined();
  });

  it("returns undefined for an empty/whitespace-only selection", () => {
    expect(findHighlightPhrase(phrases, "   ")).toBeUndefined();
  });

  it("returns undefined rather than throwing when no phrases are available for the segment", () => {
    expect(findHighlightPhrase(undefined, "go a long way toward")).toBeUndefined();
  });
});
