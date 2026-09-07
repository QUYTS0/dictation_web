import { buildScriptRenderItems } from "@/app/dictation/[videoId]/helpers";
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
