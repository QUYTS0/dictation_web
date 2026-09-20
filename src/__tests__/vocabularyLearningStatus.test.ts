import {
  getVocabularyLearningStatus,
  inferVocabularyItemKind,
  isVocabularyItemReviewable,
} from "@/lib/utils/vocabulary";

describe("getVocabularyLearningStatus", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("classifies a never-reviewed item as new, even though next_review_at defaults to a past instant", () => {
    // next_review_at is set to "now()" at insert time by the DB default, so
    // by the time this is read it's always <= now — must not be read as "due".
    expect(
      getVocabularyLearningStatus(
        { next_review_at: "2026-06-15T11:59:00.000Z", last_reviewed_at: null },
        now
      )
    ).toBe("new");
  });

  it("classifies a legacy row (reviewed=null, arbitrary next_review_at) as new", () => {
    expect(
      getVocabularyLearningStatus(
        { next_review_at: "2020-01-01T00:00:00.000Z", last_reviewed_at: null },
        now
      )
    ).toBe("new");
  });

  it("classifies a reviewed item whose next review is in the future as learning", () => {
    expect(
      getVocabularyLearningStatus(
        { next_review_at: "2026-06-20T00:00:00.000Z", last_reviewed_at: "2026-06-15T00:00:00.000Z" },
        now
      )
    ).toBe("learning");
  });

  it("classifies a reviewed item whose next review has passed as due", () => {
    expect(
      getVocabularyLearningStatus(
        { next_review_at: "2026-06-10T00:00:00.000Z", last_reviewed_at: "2026-06-01T00:00:00.000Z" },
        now
      )
    ).toBe("due");
  });

  it("treats next_review_at exactly equal to now as due (boundary is inclusive)", () => {
    expect(
      getVocabularyLearningStatus(
        { next_review_at: now.toISOString(), last_reviewed_at: "2026-06-01T00:00:00.000Z" },
        now
      )
    ).toBe("due");
  });

  it("classifies a failed review (repetitions reset to 0, but last_reviewed_at set) as due, not new", () => {
    // POST /api/vocabulary/review sets last_reviewed_at unconditionally, even
    // for grade "again" (src/lib/utils/srs.ts resets repetitions/interval to
    // 0 for "again", but never touches last_reviewed_at).
    expect(
      getVocabularyLearningStatus(
        { next_review_at: "2026-06-15T12:00:00.000Z", last_reviewed_at: "2026-06-15T12:00:00.000Z" },
        now
      )
    ).toBe("due");
  });
});

describe("isVocabularyItemReviewable", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  // A never-reviewed item whose next_review_at happens to be in the future
  // isn't possible via today's insert path (which always defaults
  // next_review_at to now()), but the predicate must not assume that
  // invariant — status and reviewability are independent questions.
  it("is not reviewable when next_review_at is in the future, even for a never-reviewed (new) item", () => {
    const item = { next_review_at: "2026-06-16T00:00:00.000Z", last_reviewed_at: null };
    expect(getVocabularyLearningStatus(item, now)).toBe("new");
    expect(isVocabularyItemReviewable(item, now)).toBe(false);
  });

  it("is reviewable when next_review_at has passed for a never-reviewed (new) item", () => {
    const item = { next_review_at: "2026-06-15T11:00:00.000Z", last_reviewed_at: null };
    expect(getVocabularyLearningStatus(item, now)).toBe("new");
    expect(isVocabularyItemReviewable(item, now)).toBe(true);
  });

  it("matches the review queue's own admission filter for a due item", () => {
    const item = { next_review_at: "2026-06-10T00:00:00.000Z", last_reviewed_at: "2026-06-01T00:00:00.000Z" };
    expect(getVocabularyLearningStatus(item, now)).toBe("due");
    expect(isVocabularyItemReviewable(item, now)).toBe(true);
  });

  it("is not reviewable for a learning item not yet due", () => {
    const item = { next_review_at: "2026-06-20T00:00:00.000Z", last_reviewed_at: "2026-06-15T00:00:00.000Z" };
    expect(getVocabularyLearningStatus(item, now)).toBe("learning");
    expect(isVocabularyItemReviewable(item, now)).toBe(false);
  });

  it("treats next_review_at exactly equal to now as reviewable (boundary is inclusive)", () => {
    expect(isVocabularyItemReviewable({ next_review_at: now.toISOString() }, now)).toBe(true);
  });
});

describe("inferVocabularyItemKind", () => {
  it("classifies a single-word term as a word", () => {
    expect(inferVocabularyItemKind({ term: "reimburse", sentence_context: "Please reimburse me." })).toBe(
      "word"
    );
  });

  it("classifies a multi-word term as a phrase", () => {
    expect(
      inferVocabularyItemKind({
        term: "go a long way toward",
        sentence_context: "Small habits go a long way toward better health.",
      })
    ).toBe("phrase");
  });

  it("classifies a term equal to its own sentence context as a sentence", () => {
    const text = "We had to postpone the meeting.";
    expect(inferVocabularyItemKind({ term: text, sentence_context: text })).toBe("sentence");
  });
});
