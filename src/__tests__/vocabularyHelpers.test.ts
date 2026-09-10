import {
  filterVocabularyItems,
  normalizeForSearch,
  resolveVocabularyHighlightMeta,
  splitSentenceForHighlight,
} from "@/app/dictation/[videoId]/helpers";
import type { LessonSavedItem } from "@/app/dictation/[videoId]/types";
import type { VocabHighlightPhrase } from "@/lib/types";

function makeItem(overrides: Partial<LessonSavedItem> = {}): LessonSavedItem {
  return {
    id: "item-1",
    user_id: "user-1",
    video_id: "video-1",
    segment_index: 0,
    term: "reimburse",
    normalized_term: "reimburse",
    canonical_form: null,
    learning_pattern: null,
    sentence_context: "The company will reimburse your travel expenses.",
    note: null,
    translation: "hoàn trả",
    translation_language: "vi",
    translation_source: "azure",
    phonetic: null,
    part_of_speech: null,
    definition: null,
    definition_source: null,
    audio_url: null,
    image_url: null,
    image_thumbnail_url: null,
    image_attribution: null,
    image_source_url: null,
    created_at: "2026-01-01T00:00:00.000Z",
    next_review_at: "2026-01-02T00:00:00.000Z",
    interval_days: 1,
    ease_factor: 2.5,
    repetitions: 0,
    last_reviewed_at: null,
    type: "word",
    ...overrides,
  };
}

describe("normalizeForSearch", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeForSearch("  Reimburse   Travel ")).toBe("reimburse travel");
  });

  it("strips Latin combining diacritics from Vietnamese text", () => {
    expect(normalizeForSearch("hoàn trả")).toBe("hoan tra");
    expect(normalizeForSearch("tiếng việt")).toBe("tieng viet");
  });

  it("folds đ/Đ to d, which NFD decomposition alone does not cover", () => {
    expect(normalizeForSearch("đường")).toBe("duong");
    expect(normalizeForSearch("Đường")).toBe("duong");
  });
});

describe("filterVocabularyItems", () => {
  const items: LessonSavedItem[] = [
    makeItem({ id: "1", term: "reimburse", translation: "hoàn trả", type: "word" }),
    makeItem({
      id: "2",
      term: "go a long way toward",
      translation: "góp phần đáng kể vào",
      sentence_context: "Small habits go a long way toward better health.",
      type: "phrase",
    }),
    makeItem({ id: "3", term: "postpone", translation: "trì hoãn", sentence_context: "We had to postpone the meeting.", type: "word" }),
  ];

  it("matches the English saved term, case-insensitively", () => {
    const result = filterVocabularyItems(items, "REIMBURSE", "all");
    expect(result.map((i) => i.id)).toEqual(["1"]);
  });

  it("matches the Vietnamese translation, accent-insensitively", () => {
    const result = filterVocabularyItems(items, "tri hoan", "all");
    expect(result.map((i) => i.id)).toEqual(["3"]);
  });

  it("matches the source sentence", () => {
    const result = filterVocabularyItems(items, "better health", "all");
    expect(result.map((i) => i.id)).toEqual(["2"]);
  });

  it("filters by type", () => {
    expect(filterVocabularyItems(items, "", "word").map((i) => i.id)).toEqual(["1", "3"]);
    expect(filterVocabularyItems(items, "", "phrase").map((i) => i.id)).toEqual(["2"]);
    expect(filterVocabularyItems(items, "", "all")).toHaveLength(3);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterVocabularyItems(items, "zzz-no-match", "all")).toEqual([]);
  });

  it("also searches the resolved canonical form when a resolver is given", () => {
    const resolveMeta = (item: LessonSavedItem) =>
      item.id === "1" ? { canonicalForm: "reimburse someone for something" } : {};
    const result = filterVocabularyItems(items, "someone for something", "all", resolveMeta);
    expect(result.map((i) => i.id)).toEqual(["1"]);
  });
});

describe("resolveVocabularyHighlightMeta", () => {
  const phrase: VocabHighlightPhrase = {
    phrase: "go a long way toward",
    translation: "góp phần đáng kể vào",
    canonicalForm: "go a long way toward(s)",
    learningPattern: "go a long way toward(s) + noun/V-ing",
  };
  const phrasesBySegmentIndex = new Map<number, VocabHighlightPhrase[]>([[0, [phrase]]]);

  it("prefers the persisted canonical_form/learning_pattern columns over the highlight cache", () => {
    const item = makeItem({
      segment_index: 0,
      term: "go a long way toward",
      canonical_form: "go a long way toward(s) [persisted]",
      learning_pattern: "persisted pattern",
    });
    expect(resolveVocabularyHighlightMeta(item, phrasesBySegmentIndex)).toEqual({
      canonicalForm: "go a long way toward(s) [persisted]",
      learningPattern: "persisted pattern",
    });
  });

  it("falls back to the highlight cache, per field, when a persisted field is null (legacy row)", () => {
    const item = makeItem({
      segment_index: 0,
      term: "go a long way toward",
      canonical_form: "go a long way toward(s) [persisted]",
      learning_pattern: null,
    });
    expect(resolveVocabularyHighlightMeta(item, phrasesBySegmentIndex)).toEqual({
      canonicalForm: "go a long way toward(s) [persisted]",
      learningPattern: "go a long way toward(s) + noun/V-ing",
    });
  });

  it("uses the highlight cache for a matching highlight in the same segment when nothing is persisted", () => {
    const item = makeItem({ segment_index: 0, term: "go a long way toward" });
    expect(resolveVocabularyHighlightMeta(item, phrasesBySegmentIndex)).toEqual({
      canonicalForm: "go a long way toward(s)",
      learningPattern: "go a long way toward(s) + noun/V-ing",
    });
  });

  it("returns nothing when the segment has no loaded highlights (legacy or not-yet-fetched)", () => {
    const item = makeItem({ segment_index: 5, term: "go a long way toward" });
    expect(resolveVocabularyHighlightMeta(item, phrasesBySegmentIndex)).toEqual({});
  });

  it("returns nothing when the segment's highlights don't include this term (freeform selection)", () => {
    const item = makeItem({ segment_index: 0, term: "some other phrase" });
    expect(resolveVocabularyHighlightMeta(item, phrasesBySegmentIndex)).toEqual({});
  });
});

describe("splitSentenceForHighlight", () => {
  it("splits around the term, case-insensitively", () => {
    const segments = splitSentenceForHighlight("The company will reimburse your travel expenses.", "Reimburse");
    expect(segments).toEqual([
      { text: "The company will ", matched: false },
      { text: "reimburse", matched: true },
      { text: " your travel expenses.", matched: false },
    ]);
  });

  it("returns the whole sentence unmatched when the term isn't found", () => {
    const segments = splitSentenceForHighlight("The company will reimburse your travel expenses.", "nowhere");
    expect(segments).toEqual([{ text: "The company will reimburse your travel expenses.", matched: false }]);
  });

  it("handles a match at the very start of the sentence", () => {
    const segments = splitSentenceForHighlight("Postpone the meeting.", "Postpone");
    expect(segments).toEqual([
      { text: "Postpone", matched: true },
      { text: " the meeting.", matched: false },
    ]);
  });
});
