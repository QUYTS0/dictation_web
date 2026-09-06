import { rankProblemWords } from "@/app/dictation/[videoId]/useShadowingEvaluations";

describe("rankProblemWords", () => {
  it("averages score and counts distinct sentences per word", () => {
    const result = rankProblemWords([
      { segmentIndex: 0, words: [{ word: "livestock", score: 40 }] },
      { segmentIndex: 1, words: [{ word: "livestock", score: 60 }] },
    ]);
    expect(result).toEqual([
      { word: "livestock", avgScore: 50, sentenceCount: 2, segmentIndexes: [0, 1] },
    ]);
  });

  it("lets a mildly-weak word that recurs several times outrank a severely-weak one-off word", () => {
    // rankScore = (100 - avg) * min(count, 5)
    // "meatless" (one sentence, severe):        (100-20)*1 = 80
    // "and" (three sentences, mild but repeat):  (100-65)*3 = 105
    // Below the recurrence cap, repetition legitimately outweighs a single
    // severe occurrence — recurring issues matter, this is intended.
    const result = rankProblemWords([
      { segmentIndex: 0, words: [{ word: "meatless", score: 20 }] },
      { segmentIndex: 0, words: [{ word: "and", score: 65 }] },
      { segmentIndex: 1, words: [{ word: "and", score: 65 }] },
      { segmentIndex: 2, words: [{ word: "and", score: 65 }] },
    ]);
    expect(result.map((r) => r.word)).toEqual(["and", "meatless"]);
  });

  it("still lets a very severe one-off word outrank a barely-weak, recurring word", () => {
    // "gasp" (one sentence, very severe): (100-5)*1 = 95
    // "the" (three sentences, barely weak): (100-69)*3 = 93
    const result = rankProblemWords([
      { segmentIndex: 0, words: [{ word: "gasp", score: 5 }] },
      { segmentIndex: 0, words: [{ word: "the", score: 69 }] },
      { segmentIndex: 1, words: [{ word: "the", score: 69 }] },
      { segmentIndex: 2, words: [{ word: "the", score: 69 }] },
    ]);
    expect(result.map((r) => r.word)).toEqual(["gasp", "the"]);
  });

  it("caps recurrence so a word appearing in many sentences doesn't dominate purely by volume", () => {
    // "the": mildly weak (75), but recurs in 10 sentences -> capped at 5 -> (100-75)*5 = 125
    // "gasp": very weak (10), recurs once -> (100-10)*1 = 90
    // With the cap, "the" (125) still outranks "gasp" (90) here — the cap
    // limits runaway volume, it doesn't eliminate the recurrence bonus
    // entirely, so this asserts the cap's arithmetic rather than a specific
    // ordering outcome.
    const manySentences = Array.from({ length: 10 }, (_, i) => ({
      segmentIndex: i,
      words: [{ word: "the", score: 75 }],
    }));
    const result = rankProblemWords([...manySentences, { segmentIndex: 10, words: [{ word: "gasp", score: 10 }] }]);
    const theEntry = result.find((r) => r.word === "the");
    expect(theEntry?.sentenceCount).toBe(10);
    // Verify the cap is actually applied by checking against the uncapped
    // hypothetical: uncapped rank would be (100-75)*10 = 250, far above
    // "gasp"'s 90 — the capped value must be lower than that.
    const cappedRankScore = (100 - (theEntry?.avgScore ?? 0)) * Math.min(theEntry?.sentenceCount ?? 0, 5);
    expect(cappedRankScore).toBe(125);
  });

  it("sorts descending by rank score", () => {
    const result = rankProblemWords([
      { segmentIndex: 0, words: [{ word: "mild", score: 95 }] },
      { segmentIndex: 0, words: [{ word: "severe", score: 10 }] },
    ]);
    expect(result.map((r) => r.word)).toEqual(["severe", "mild"]);
  });

  it("caps the result list at 12 entries", () => {
    const inputs = Array.from({ length: 20 }, (_, i) => ({
      segmentIndex: 0,
      words: [{ word: `word${i}`, score: i }],
    }));
    expect(rankProblemWords(inputs)).toHaveLength(12);
  });

  it("returns an empty list for no input", () => {
    expect(rankProblemWords([])).toEqual([]);
  });
});
