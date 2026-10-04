/**
 * Deterministic Dictation analysis for the round report (Learning Reports
 * plan §4, "Layer A") — no AI, no network, pure functions.
 *
 * Three separate stages, never mixed:
 *   1. Correctness is AUTHORITATIVE and comes from the stored attempt
 *      (`is_correct`, decided in SQL by fn_record_dictation_attempt under the
 *      stored `match_mode`). Nothing here re-judges an answer.
 *   2. Display alignment recomputes the same normalization (normalizeText,
 *      the TypeScript mirror of fn_normalize_dictation_text — parity is
 *      asserted by phase3-scoring-parity.integration.test.ts) and a word diff.
 *   3. Observations are factual differences found by explicit rules only
 *      (missing / extra words, a word ending, a close spelling, a contraction,
 *      a number form, or a neutral "words differ"). Nothing is inferred about
 *      hearing, grammar knowledge, comprehension or pronunciation.
 *
 * When the recomputed comparison disagrees with the stored result, the stored
 * result wins and the row says so neutrally (no difference highlighting, no
 * category). Answers stored without a matching rule (pre-Phase-3) are shown
 * as a raw comparison without categories.
 */
import { normalizeText, normalizeWhitespace, removePunctuation, wordDiff } from "@/lib/utils/text";
import type { DiffToken, MatchMode } from "@/lib/types";
import type { ReportSentence } from "@/lib/types/learning";

// ---------------------------------------------------------------- evidence

/** One stored, practice-valid Dictation answer (as the report route reads it). */
export interface DictationAnswerEvidence {
  attemptId: string;
  userText: string;
  /** null = recorded before matching rules were stored (legacy). */
  matchMode: MatchMode | null;
  isCorrect: boolean;
  createdAt: string;
}

export interface SentenceDictationEvidence {
  segmentIndex: number;
  /** Practice-valid answers (an idempotent retry is one row, so it counts once). */
  validSubmissions: number;
  validIncorrect: number;
  /** The latest practice-valid answer. */
  latest: DictationAnswerEvidence | null;
  /** The latest practice-valid INCORRECT answer (for a corrected sentence: its last mistake). */
  lastWrong: DictationAnswerEvidence | null;
}

export interface DictationEvidence {
  validSubmissions: number;
  validCorrect: number;
  /** Stored answers that don't count as practice (e.g. empty). */
  invalidSubmissions: number;
  sentences: SentenceDictationEvidence[];
}

/** A row of attempt_logs as the report route selects it. */
export interface AttemptEvidenceRow {
  id: string;
  segment_index: number;
  user_text: string | null;
  is_correct: boolean;
  is_practice_valid: boolean | null;
  match_mode: string | null;
  created_at: string;
}

const MODES: readonly MatchMode[] = ["exact", "relaxed", "learning"];
const asMode = (v: string | null): MatchMode | null => (v && (MODES as readonly string[]).includes(v) ? (v as MatchMode) : null);

/**
 * Builds per-sentence evidence from the round's stored answers, in the
 * server's canonical order (created_at, then id). `is_practice_valid` null
 * (pre-Phase-3 rows) counts as valid, as fn_round_report does for its
 * practice-valid set.
 */
export function buildDictationEvidence(rows: AttemptEvidenceRow[]): DictationEvidence {
  const ordered = [...rows].sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.created_at < b.created_at ? -1 : 1));
  const bySentence = new Map<number, SentenceDictationEvidence>();
  let validSubmissions = 0;
  let validCorrect = 0;
  let invalidSubmissions = 0;
  for (const row of ordered) {
    if (row.is_practice_valid === false) {
      invalidSubmissions += 1;
      continue;
    }
    validSubmissions += 1;
    if (row.is_correct) validCorrect += 1;
    const entry =
      bySentence.get(row.segment_index) ??
      ({ segmentIndex: row.segment_index, validSubmissions: 0, validIncorrect: 0, latest: null, lastWrong: null } as SentenceDictationEvidence);
    const answer: DictationAnswerEvidence = {
      attemptId: row.id,
      userText: row.user_text ?? "",
      matchMode: asMode(row.match_mode),
      isCorrect: row.is_correct,
      createdAt: row.created_at,
    };
    entry.validSubmissions += 1;
    entry.latest = answer;
    if (!row.is_correct) {
      entry.validIncorrect += 1;
      entry.lastWrong = answer;
    }
    bySentence.set(row.segment_index, entry);
  }
  return {
    validSubmissions,
    validCorrect,
    invalidSubmissions,
    sentences: [...bySentence.values()].sort((a, b) => a.segmentIndex - b.segmentIndex),
  };
}

// ------------------------------------------------------------ observations

export type Observation =
  | { kind: "missing"; words: string[] }
  | { kind: "extra"; words: string[] }
  | { kind: "ending"; answer: string; reference: string }
  | { kind: "spelling"; answer: string; reference: string }
  | { kind: "contraction"; answer: string; reference: string }
  | { kind: "number"; answer: string; reference: string }
  | { kind: "substitution"; answer: string; reference: string }
  | { kind: "case" }
  | { kind: "punctuation" }
  | { kind: "case_punctuation" };

export type AnswerAnalysisStatus =
  /** The recomputed comparison agrees with the stored result. */
  | "consistent"
  /** Stored incorrect, but equal under the current rules — the stored result stands. */
  | "marked_incorrect_unexplained"
  /** Stored correct, but different under the current rules — the stored result stands. */
  | "accepted_as_correct"
  /** No stored matching rule (older answer): raw comparison, no categories. */
  | "rule_unknown";

export interface AnswerAnalysis {
  status: AnswerAnalysisStatus;
  /** Word alignment in comparison form; empty when no differences are shown. */
  tokens: DiffToken[];
  observations: Observation[];
  /** Exact (reference → answer) single-word substitutions, for recurring statistics. */
  substitutions: { reference: string; answer: string }[];
  /** How the comparison was made, for the row's footnote. */
  comparison: "ignores_case_and_punctuation" | "exact" | "raw";
}

const CONTRACTIONS: Record<string, string> = {
  "don't": "do not", "doesn't": "does not", "didn't": "did not", "can't": "cannot", "won't": "will not",
  "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not", "haven't": "have not",
  "hasn't": "has not", "hadn't": "had not", "wouldn't": "would not", "shouldn't": "should not", "couldn't": "could not",
  "i'm": "i am", "you're": "you are", "we're": "we are", "they're": "they are", "he's": "he is", "she's": "she is",
  "it's": "it is", "that's": "that is", "there's": "there is", "what's": "what is", "let's": "let us",
  "i've": "i have", "you've": "you have", "we've": "we have", "they've": "they have",
  "i'll": "i will", "you'll": "you will", "we'll": "we will", "they'll": "they will", "he'll": "he will",
  "she'll": "she will", "it'll": "it will", "i'd": "i would", "you'd": "you would", "we'd": "we would", "they'd": "they would",
};

const SMALL_NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const TENS: Record<number, string> = { 30: "thirty", 40: "forty", 50: "fifty", 60: "sixty", 70: "seventy", 80: "eighty", 90: "ninety", 100: "hundred" };
function numberWord(n: number): string | null {
  if (n >= 0 && n <= 20) return SMALL_NUMBERS[n];
  return TENS[n] ?? null;
}

const ENDINGS = ["s", "es", "ed", "d", "ing", "'s", "'"];

/** Optimal-string-alignment distance (Damerau-Levenshtein with adjacent transpositions), early exit above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function classifySingle(answer: string, reference: string): Observation {
  if (ENDINGS.some((e) => answer === reference + e || reference === answer + e)) return { kind: "ending", answer, reference };
  const digit = /^\d+$/;
  if ((digit.test(answer) && numberWord(Number(answer)) === reference) || (digit.test(reference) && numberWord(Number(reference)) === answer)) {
    return { kind: "number", answer, reference };
  }
  if (answer.length >= 4 && reference.length >= 4 && editDistance(answer, reference) <= 2) return { kind: "spelling", answer, reference };
  return { kind: "substitution", answer, reference };
}

function isContractionPair(answer: string, reference: string): boolean {
  return CONTRACTIONS[answer] === reference || CONTRACTIONS[reference] === answer || (answer === "can't" && reference === "can not");
}

const tokens = (s: string) => s.split(" ").filter(Boolean);

/** Comparison form for word-level observations: never case- or punctuation-sensitive. */
const wordForm = (s: string) => normalizeWhitespace(removePunctuation(s).toLowerCase());

function observeWords(referenceForm: string, answerForm: string): Pick<AnswerAnalysis, "tokens" | "observations" | "substitutions"> {
  const diff = wordDiff(tokens(referenceForm), tokens(answerForm));
  const observations: Observation[] = [];
  const substitutions: { reference: string; answer: string }[] = [];
  // Walk runs of changes between matched anchors.
  let refRun: string[] = [];
  let ansRun: string[] = [];
  const flush = () => {
    if (refRun.length === 0 && ansRun.length === 0) return;
    if (refRun.length === 0) observations.push({ kind: "extra", words: ansRun });
    else if (ansRun.length === 0) observations.push({ kind: "missing", words: refRun });
    else {
      const a = ansRun.join(" ");
      const r = refRun.join(" ");
      if (isContractionPair(a, r)) observations.push({ kind: "contraction", answer: a, reference: r });
      else if (refRun.length === 1 && ansRun.length === 1) {
        observations.push(classifySingle(a, r));
        substitutions.push({ reference: r, answer: a });
      } else observations.push({ kind: "substitution", answer: a, reference: r });
    }
    refRun = [];
    ansRun = [];
  };
  for (const t of diff) {
    if (t.status === "correct") flush();
    else if (t.status === "missing") refRun.push(t.word);
    else ansRun.push(t.word); // "extra" or "wrong" — both are the learner's words
  }
  flush();
  return { tokens: diff, observations, substitutions };
}

/**
 * Analyses ONE stored answer against the sentence's pinned reference text.
 * Never changes correctness: `answer.isCorrect` is the stored, authoritative
 * result.
 */
export function analyzeAnswer(reference: string, answer: DictationAnswerEvidence): AnswerAnalysis {
  if (answer.matchMode === null) {
    const w = observeWords(wordForm(reference), wordForm(answer.userText));
    return { status: "rule_unknown", tokens: answer.isCorrect ? [] : w.tokens, observations: [], substitutions: [], comparison: "raw" };
  }
  const mode = answer.matchMode;
  const ref = normalizeText(reference, mode);
  const ans = normalizeText(answer.userText, mode);
  const equalNow = ref === ans;
  const comparison = mode === "exact" ? "exact" : "ignores_case_and_punctuation";
  if (equalNow !== answer.isCorrect) {
    return {
      status: answer.isCorrect ? "accepted_as_correct" : "marked_incorrect_unexplained",
      tokens: [],
      observations: [],
      substitutions: [],
      comparison,
    };
  }
  if (answer.isCorrect) return { status: "consistent", tokens: [], observations: [], substitutions: [], comparison };

  if (mode === "exact") {
    const ws = (s: string) => normalizeWhitespace(s);
    const caseOnly = ref.toLowerCase() === ans.toLowerCase();
    const punctOnly = ws(removePunctuation(ref)) === ws(removePunctuation(ans));
    const both = wordForm(ref) === wordForm(ans);
    if (caseOnly || punctOnly || both) {
      const kind = caseOnly ? "case" : punctOnly ? "punctuation" : "case_punctuation";
      return { status: "consistent", tokens: [], observations: [{ kind }], substitutions: [], comparison };
    }
  }
  return { status: "consistent", ...observeWords(wordForm(ref), wordForm(ans)), comparison };
}

/** Plain-language wording for one observation (factual, never a diagnosis). */
export function describeObservation(o: Observation): string {
  switch (o.kind) {
    case "missing":
      return `Missing: ${o.words.join(" ")}`;
    case "extra":
      return `Extra: ${o.words.join(" ")}`;
    case "ending":
      return `You wrote “${o.answer}”; the reference has “${o.reference}”`;
    case "spelling":
      return `Spelling: “${o.answer}” → “${o.reference}”`;
    case "contraction":
      return `Contraction differs: “${o.answer}” / “${o.reference}”`;
    case "number":
      return `Number written differently: “${o.answer}” / “${o.reference}”`;
    case "substitution":
      return `“${o.answer}” → “${o.reference}”`;
    case "case":
      return "Capitalization differs";
    case "punctuation":
      return "Punctuation differs";
    case "case_punctuation":
      return "Capitalization and punctuation differ";
  }
}

// ----------------------------------------------------------- round summary

export type DictationPriority =
  | { kind: "still_incorrect"; segmentIndex: number; incorrectAnswers: number }
  | { kind: "recurring"; reference: string; answer: string; segmentIndexes: number[] }
  | { kind: "hard_corrected"; segmentIndex: number; incorrectAnswers: number };

export interface DictationRoundAnalysis {
  /** Valid incorrect answers (retries count once). */
  incorrectSubmissions: number;
  distinctEverIncorrect: number;
  currentlyIncorrect: number;
  corrected: number;
  /** correct ÷ valid answers — "correct across valid answers", never called accuracy. */
  validSubmissionCorrectness: { correct: number; valid: number } | null;
  invalidSubmissions: number;
  /** Per sentence: the analysis shown in its row (latest wrong answer, or the last mistake before a correction). */
  bySentence: Map<number, { analysis: AnswerAnalysis; answer: DictationAnswerEvidence; incorrectAnswers: number }>;
  recurring: { reference: string; answer: string; segmentIndexes: number[] }[];
  /** Deterministic order (plan §4.4): still incorrect, recurring pairs, corrected after ≥ 3 incorrect answers. */
  priorities: DictationPriority[];
}

export const HARD_CORRECTED_MIN_INCORRECT = 3;

export function analyzeDictationRound(sentences: ReportSentence[], evidence: DictationEvidence | null | undefined): DictationRoundAnalysis {
  const evidenceBy = new Map((evidence?.sentences ?? []).map((s) => [s.segmentIndex, s]));
  const bySentence: DictationRoundAnalysis["bySentence"] = new Map();
  const pairSentences = new Map<string, { reference: string; answer: string; segs: Set<number> }>();
  let currentlyIncorrect = 0;
  let corrected = 0;
  let distinctEverIncorrect = 0;

  for (const s of sentences) {
    if (!s.dictation) continue;
    if (s.dictation.everIncorrect) distinctEverIncorrect += 1;
    if (s.category === "needs_review") currentlyIncorrect += 1;
    if (s.category === "corrected") corrected += 1;
    const ev = evidenceBy.get(s.segmentIndex);
    if (!ev || s.text === null) continue;
    const shown = s.category === "needs_review" ? ev.latest : s.category === "corrected" ? ev.lastWrong : null;
    if (!shown || shown.isCorrect) continue;
    const analysis = analyzeAnswer(s.text, shown);
    bySentence.set(s.segmentIndex, { analysis, answer: shown, incorrectAnswers: ev.validIncorrect });
    for (const sub of new Map(analysis.substitutions.map((p) => [`${p.reference}\u0000${p.answer}`, p])).values()) {
      const key = `${sub.reference}\u0000${sub.answer}`;
      const entry = pairSentences.get(key) ?? { ...sub, segs: new Set<number>() };
      entry.segs.add(s.segmentIndex);
      pairSentences.set(key, entry);
    }
  }

  const recurring = [...pairSentences.values()]
    .filter((p) => p.segs.size >= 2)
    .map((p) => ({ reference: p.reference, answer: p.answer, segmentIndexes: [...p.segs].sort((a, b) => a - b) }))
    .sort((a, b) => b.segmentIndexes.length - a.segmentIndexes.length || a.reference.localeCompare(b.reference) || a.answer.localeCompare(b.answer));

  const incorrectCount = (i: number) => evidenceBy.get(i)?.validIncorrect ?? 0;
  const still = sentences
    .filter((s) => s.category === "needs_review")
    .map((s) => ({ kind: "still_incorrect" as const, segmentIndex: s.segmentIndex, incorrectAnswers: incorrectCount(s.segmentIndex) }))
    .sort((a, b) => b.incorrectAnswers - a.incorrectAnswers || a.segmentIndex - b.segmentIndex);
  const hard = sentences
    .filter((s) => s.category === "corrected" && incorrectCount(s.segmentIndex) >= HARD_CORRECTED_MIN_INCORRECT)
    .map((s) => ({ kind: "hard_corrected" as const, segmentIndex: s.segmentIndex, incorrectAnswers: incorrectCount(s.segmentIndex) }))
    .sort((a, b) => b.incorrectAnswers - a.incorrectAnswers || a.segmentIndex - b.segmentIndex);

  return {
    incorrectSubmissions: evidence ? evidence.validSubmissions - evidence.validCorrect : 0,
    distinctEverIncorrect,
    currentlyIncorrect,
    corrected,
    validSubmissionCorrectness: evidence && evidence.validSubmissions > 0 ? { correct: evidence.validCorrect, valid: evidence.validSubmissions } : null,
    invalidSubmissions: evidence?.invalidSubmissions ?? 0,
    bySentence,
    recurring,
    priorities: [...still, ...recurring.map((r) => ({ kind: "recurring" as const, ...r })), ...hard],
  };
}
