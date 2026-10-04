/**
 * Learning Reports P1 (plan §4): the deterministic Dictation analysis never
 * re-judges an answer — the stored result is authoritative — and only names
 * differences demonstrated by explicit rules.
 */
import {
  analyzeAnswer,
  analyzeDictationRound,
  buildDictationEvidence,
  describeObservation,
  editDistance,
  type AttemptEvidenceRow,
  type DictationAnswerEvidence,
} from "@/lib/practice/dictationAnalysis";
import type { ReportSentence } from "@/lib/types/learning";

const answer = (userText: string, matchMode: DictationAnswerEvidence["matchMode"], isCorrect: boolean): DictationAnswerEvidence => ({
  attemptId: "a1",
  userText,
  matchMode,
  isCorrect,
  createdAt: "2026-10-01T10:00:00Z",
});
const kinds = (a: ReturnType<typeof analyzeAnswer>) => a.observations.map((o) => o.kind);

describe("analyzeAnswer — exact mode", () => {
  const REF = "The cat sat, quietly.";
  it("case only", () => {
    const a = analyzeAnswer(REF, answer("the cat sat, quietly.", "exact", false));
    expect(a.status).toBe("consistent");
    expect(kinds(a)).toEqual(["case"]);
    expect(a.tokens).toEqual([]);
  });
  it("punctuation only", () => {
    const a = analyzeAnswer(REF, answer("The cat sat quietly", "exact", false));
    expect(kinds(a)).toEqual(["punctuation"]);
  });
  it("case and punctuation together", () => {
    const a = analyzeAnswer(REF, answer("the cat sat quietly", "exact", false));
    expect(kinds(a)).toEqual(["case_punctuation"]);
    expect(describeObservation(a.observations[0])).toBe("Capitalization and punctuation differ");
  });
  it("real word differences are word observations, compared without case/punctuation", () => {
    const a = analyzeAnswer(REF, answer("The cat sit quietly.", "exact", false));
    expect(a.status).toBe("consistent");
    expect(a.observations).toEqual([{ kind: "substitution", answer: "sit", reference: "sat" }]);
    expect(a.comparison).toBe("exact");
  });
});

describe("analyzeAnswer — relaxed mode", () => {
  it("case and punctuation never cause or appear in observations", () => {
    const a = analyzeAnswer("It spans two weeks.", answer("it span two weeks", "relaxed", false));
    expect(a.observations).toEqual([{ kind: "ending", answer: "span", reference: "spans" }]);
    expect(a.comparison).toBe("ignores_case_and_punctuation");
    expect(describeObservation(a.observations[0])).toBe("You wrote “span”; the reference has “spans”");
  });
  it("missing, extra, spelling, number and contraction differences", () => {
    expect(analyzeAnswer("I saw the dog", answer("I saw dog", "relaxed", false)).observations).toEqual([{ kind: "missing", words: ["the"] }]);
    expect(analyzeAnswer("I saw the dog", answer("I saw the big dog", "relaxed", false)).observations).toEqual([{ kind: "extra", words: ["big"] }]);
    expect(kinds(analyzeAnswer("I will receive it", answer("I will recieve it", "relaxed", false)))).toEqual(["spelling"]);
    expect(kinds(analyzeAnswer("I have five cats", answer("I have 5 cats", "relaxed", false)))).toEqual(["number"]);
    expect(kinds(analyzeAnswer("I do not know", answer("I don't know", "relaxed", false)))).toEqual(["contraction"]);
    expect(kinds(analyzeAnswer("a cat sat", answer("a hat sat", "relaxed", false)))).toEqual(["substitution"]);
  });
  it("a correct answer has nothing to show", () => {
    const a = analyzeAnswer("Hello there.", answer("hello there", "relaxed", true));
    expect(a).toMatchObject({ status: "consistent", tokens: [], observations: [] });
  });
});

describe("analyzeAnswer — stored result stays authoritative", () => {
  it("legacy answers (no stored matching rule) get a raw comparison, no categories", () => {
    const a = analyzeAnswer("The cat sat.", answer("the hat sat", null, false));
    expect(a.status).toBe("rule_unknown");
    expect(a.observations).toEqual([]);
    expect(a.tokens.length).toBeGreaterThan(0);
  });
  it("stored incorrect but equal under the current rules → discrepancy, never a punctuation claim", () => {
    const a = analyzeAnswer("Hello there.", answer("hello there", "relaxed", false));
    expect(a.status).toBe("marked_incorrect_unexplained");
    expect(a.observations).toEqual([]);
  });
  it("stored correct but different under the current rules → accepted as correct, never labelled incorrect", () => {
    const a = analyzeAnswer("Hello there.", answer("hello world", "relaxed", true));
    expect(a.status).toBe("accepted_as_correct");
    expect(a.tokens).toEqual([]);
  });
});

it("editDistance counts an adjacent transposition as one edit", () => {
  expect(editDistance("recieve", "receive")).toBe(1);
  expect(editDistance("cat", "dog")).toBeGreaterThan(2);
});

// ------------------------------------------------------------ round level

const row = (id: string, seg: number, text: string, correct: boolean, at: string, over: Partial<AttemptEvidenceRow> = {}): AttemptEvidenceRow => ({
  id, segment_index: seg, user_text: text, is_correct: correct, is_practice_valid: true, match_mode: "relaxed", created_at: at, ...over,
});
const sentence = (i: number, text: string, category: ReportSentence["category"], everIncorrect: boolean): ReportSentence => ({
  segmentIndex: i, text, eligible: true, category,
  dictation: { submissions: 1, practiceSubmissions: 1, first: null, latest: null, everIncorrect },
  shadowing: null,
});

describe("buildDictationEvidence / analyzeDictationRound", () => {
  const rows = [
    row("a", 0, "the cat sit", false, "2026-10-01T10:00:01Z"),
    row("b", 0, "the cat sit", false, "2026-10-01T10:00:02Z"),
    row("c", 0, "the cat sat", true, "2026-10-01T10:00:03Z"),
    row("d", 1, "a dog sit down", false, "2026-10-01T10:00:04Z"),
    row("e", 2, "", false, "2026-10-01T10:00:05Z", { is_practice_valid: false }),
    row("f", 3, "it runs", false, "2026-10-01T10:00:06Z"),
    row("g", 3, "it runs", false, "2026-10-01T10:00:07Z"),
    row("h", 3, "it runs", false, "2026-10-01T10:00:08Z"),
    row("i", 3, "it ran", true, "2026-10-01T10:00:09Z"),
  ];
  const sentences = [
    sentence(0, "The cat sat.", "corrected", true),
    sentence(1, "A dog sat down.", "needs_review", true),
    sentence(3, "It ran.", "corrected", true),
  ];

  it("units are kept apart: incorrect answers, sentences ever wrong, still wrong, corrected", () => {
    const ev = buildDictationEvidence(rows);
    expect(ev).toMatchObject({ validSubmissions: 8, validCorrect: 2, invalidSubmissions: 1 });
    const r = analyzeDictationRound(sentences, ev);
    expect(r.incorrectSubmissions).toBe(6);
    expect(r.distinctEverIncorrect).toBe(3);
    expect(r.currentlyIncorrect).toBe(1);
    expect(r.corrected).toBe(2);
    expect(r.validSubmissionCorrectness).toEqual({ correct: 2, valid: 8 });
  });

  it("a corrected sentence is analysed on its LAST mistake, a still-wrong one on its latest answer", () => {
    const r = analyzeDictationRound(sentences, buildDictationEvidence(rows));
    expect(r.bySentence.get(0)?.answer.attemptId).toBe("b");
    expect(r.bySentence.get(1)?.answer.attemptId).toBe("d");
  });

  it("recurring pairs need two sentences; priorities: still wrong, recurring, then hard corrections", () => {
    const r = analyzeDictationRound(sentences, buildDictationEvidence(rows));
    expect(r.recurring).toEqual([{ reference: "sat", answer: "sit", segmentIndexes: [0, 1] }]);
    expect(r.priorities.map((p) => p.kind)).toEqual(["still_incorrect", "recurring", "hard_corrected"]);
    expect(r.priorities[2]).toMatchObject({ segmentIndex: 3, incorrectAnswers: 3 });
  });

  it("without evidence (older response) the analysis degrades to counts only", () => {
    const r = analyzeDictationRound(sentences, undefined);
    expect(r.bySentence.size).toBe(0);
    expect(r.validSubmissionCorrectness).toBeNull();
    expect(r.priorities.map((p) => p.kind)).toEqual(["still_incorrect"]);
  });
});
