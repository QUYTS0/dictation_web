/**
 * Learning Reports P5 — the server-built AI input for one round. PURE (no
 * IO); SERVER-ONLY (uses node:crypto through explanationIdentity).
 *
 * Built only from the round's owned, stored attempts and fn_round_report
 * (pinned transcript): client-supplied metrics, texts or ownership claims
 * are never an input. The metrics are the report's canonical ones
 * (analyzeDictationRound / fn_round_report), labelled as the report labels
 * them; legacy learning_sessions.accuracy is never used.
 *
 * Units kept apart: sentences (evidence), attempts (stored answers),
 * explanation targets (distinct mode-aware mistakes, P4's `p1` identity),
 * and provider requests (decided by the routes).
 */
import { createHash } from "crypto";
import { analyzeAnswer, analyzeDictationRound, buildDictationEvidence, describeObservation, type DictationAnswerEvidence } from "@/lib/practice/dictationAnalysis";
import { coveredAttemptIds, explanationPatternKey, type ExplanationAttempt, type StoredExplanation } from "@/lib/practice/explanationIdentity";
import { normalizeText } from "@/lib/utils/text";
import type { RoundReport } from "@/lib/types/learning";

export const MAX_EXPLANATION_BATCH = 35;
const MAX_POSITIVE_EVIDENCE = 12;
const MAX_TEXT_CHARS = 280;
const CONTEXT_WORDS = 6;

export interface AssessmentAttemptRow {
  id: string;
  segment_index: number;
  expected_text: string;
  user_text: string | null;
  is_correct: boolean;
  is_practice_valid: boolean | null;
  match_mode: string | null;
  created_at: string;
}

export interface AssessmentMetrics {
  eligibleSentences: number;
  practicedSentences: number;
  /** "Correct on latest answer" — the report's headline figure. */
  latestAnswerCorrect: { correct: number; practiced: number };
  /** "Correct across valid answers" — never called accuracy. */
  validSubmissionCorrectness: { correct: number; valid: number } | null;
  currentlyIncorrect: number;
  corrected: number;
  distinctEverIncorrect: number;
  invalidSubmissions: number;
  /** False: part of the round predates detailed tracking (first try / best run unavailable). */
  historyComplete: boolean;
  firstTry: { correct: number; practiced: number } | null;
  bestStreak: number | null;
}

export type EvidenceKind = "currently_incorrect" | "corrected" | "correct_evidence" | "unavailable";

export interface EvidenceItem {
  /** Stable for a given data state: S<sentence number>. */
  id: string;
  kind: EvidenceKind;
  sentence: number;
  reference: string | null;
  answer: string | null;
  /** "exact" | "relaxed" | "learning", or "unknown" for answers stored before rules were recorded. */
  matchRule: string;
  /** Factual differences found by the deterministic rules (never AI-inferred). */
  differences: string[];
  incorrectAnswers: number;
  trimmed: boolean;
}

export interface ExplanationTarget {
  /** The attempt the note is stored on (first occurrence, priority order). */
  attemptId: string;
  /** 0-based sentences sharing this exact mistake (same rule, same normalized texts). */
  segmentIndexes: number[];
  kind: "currently_incorrect" | "corrected";
  reference: string;
  answer: string;
  matchRule: string;
  /** A saved note (own, or same mistake in this round) already exists. */
  covered: boolean;
}

export interface AssessmentInput {
  metrics: AssessmentMetrics;
  /** Evidence in priority order (all of it). */
  evidence: EvidenceItem[];
  /** The prefix that fits the input budget, sent individually. */
  individual: EvidenceItem[];
  /** Everything else, as counts only. */
  aggregates: { sentences: number; byKind: Record<string, number>; byDifference: Record<string, number> };
  targets: ExplanationTarget[];
  missingTargets: ExplanationTarget[];
  fingerprint: string;
  charBudget: number;
}

export function inputCharBudget(): number {
  const n = Number(process.env.AI_INPUT_CHAR_BUDGET);
  return Number.isFinite(n) && n >= 2_000 ? Math.floor(n) : 60_000;
}

/** min(35, output-budget fit) — a ceiling, never a guarantee. */
export function explanationBatchSize(maxOutputTokens: number, reserveTokens: number, tokensPerExplanation = tokensPerExplanationSetting()): number {
  const fit = Math.floor((maxOutputTokens - reserveTokens) / Math.max(1, tokensPerExplanation));
  return Math.max(1, Math.min(MAX_EXPLANATION_BATCH, fit));
}

function tokensPerExplanationSetting(): number {
  const n = Number(process.env.AI_TOKENS_PER_EXPLANATION);
  return Number.isFinite(n) && n >= 40 ? Math.floor(n) : 180;
}

/** Characters → tokens is an ESTIMATE (≈ 4 characters per token for English). */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** Keeps long texts to the first differing span ±6 words. */
function trimPair(reference: string, answer: string): { reference: string; answer: string; trimmed: boolean } {
  if (reference.length <= MAX_TEXT_CHARS && answer.length <= MAX_TEXT_CHARS) return { reference, answer, trimmed: false };
  const r = words(reference);
  const a = words(answer);
  let i = 0;
  while (i < r.length && i < a.length && r[i].toLowerCase() === a[i].toLowerCase()) i++;
  const from = Math.max(0, i - CONTEXT_WORDS);
  const cut = (w: string[]) => {
    const part = w.slice(from, i + CONTEXT_WORDS + 1).join(" ");
    return `${from > 0 ? "… " : ""}${part.slice(0, MAX_TEXT_CHARS)}${i + CONTEXT_WORDS + 1 < w.length ? " …" : ""}`;
  };
  return { reference: cut(r), answer: cut(a), trimmed: true };
}

function isSpacingOnly(reference: string, answer: string): boolean {
  const e = normalizeText(reference, "relaxed");
  const u = normalizeText(answer, "relaxed");
  return e.replace(/\s+/g, "") === u.replace(/\s+/g, "") && e !== u;
}

export function buildAssessmentInput(args: {
  report: RoundReport;
  attempts: AssessmentAttemptRow[];
  notes: StoredExplanation[];
  charBudget?: number;
}): AssessmentInput {
  const { report, attempts, notes } = args;
  const charBudget = args.charBudget ?? inputCharBudget();
  const evidence = buildDictationEvidence(attempts);
  const analysis = analyzeDictationRound(report.sentences, evidence);
  const byId = new Map(attempts.map((a) => [a.id, a]));
  const evBy = new Map(evidence.sentences.map((s) => [s.segmentIndex, s]));

  const metrics: AssessmentMetrics = {
    eligibleSentences: report.progress?.requiredSentenceCount ?? report.sentences.filter((s) => s.eligible).length,
    practicedSentences: report.dictation.practicedSentences,
    latestAnswerCorrect: { correct: report.dictation.latestCorrect, practiced: report.dictation.practicedSentences },
    validSubmissionCorrectness: analysis.validSubmissionCorrectness,
    currentlyIncorrect: analysis.currentlyIncorrect,
    corrected: analysis.corrected,
    distinctEverIncorrect: analysis.distinctEverIncorrect,
    invalidSubmissions: analysis.invalidSubmissions,
    historyComplete: report.historyComplete,
    firstTry:
      report.dictation.firstTry.available && report.dictation.firstTry.correct !== null
        ? { correct: report.dictation.firstTry.correct, practiced: report.dictation.practicedSentences }
        : null,
    bestStreak: report.historyComplete ? report.dictation.bestStreak : null,
  };

  // ---- evidence, priority order
  const make = (kind: EvidenceKind, segmentIndex: number, reference: string | null, answer: DictationAnswerEvidence | null, incorrectAnswers: number): EvidenceItem => {
    if (!reference || !answer) {
      return { id: `S${segmentIndex + 1}`, kind: "unavailable", sentence: segmentIndex + 1, reference: null, answer: null, matchRule: "unknown", differences: [], incorrectAnswers, trimmed: false };
    }
    const a = analyzeAnswer(reference, answer);
    const t = trimPair(reference, answer.userText);
    return {
      id: `S${segmentIndex + 1}`,
      kind,
      sentence: segmentIndex + 1,
      reference: t.reference,
      answer: t.answer,
      matchRule: answer.matchMode ?? "unknown",
      differences: a.observations.slice(0, 5).map(describeObservation),
      incorrectAnswers,
      trimmed: t.trimmed,
    };
  };
  const still: EvidenceItem[] = [];
  const corrected: EvidenceItem[] = [];
  const positive: EvidenceItem[] = [];
  const unavailable: EvidenceItem[] = [];
  for (const s of report.sentences) {
    if (!s.dictation) continue;
    const ev = evBy.get(s.segmentIndex);
    const incorrect = ev?.validIncorrect ?? 0;
    if (s.category === "needs_review") {
      const item = make("currently_incorrect", s.segmentIndex, s.text, ev?.latest && !ev.latest.isCorrect ? ev.latest : null, incorrect);
      (item.kind === "unavailable" ? unavailable : still).push(item);
    } else if (s.category === "corrected") {
      const item = make("corrected", s.segmentIndex, s.text, ev?.lastWrong ?? null, incorrect);
      (item.kind === "unavailable" ? unavailable : corrected).push(item);
    } else if ((s.category === "first_try" || s.category === "correct") && ev?.latest?.isCorrect && s.text) {
      positive.push(make("correct_evidence", s.segmentIndex, s.text, ev.latest, incorrect));
    }
  }
  still.sort((a, b) => b.incorrectAnswers - a.incorrectAnswers || a.sentence - b.sentence);
  corrected.sort((a, b) => b.incorrectAnswers - a.incorrectAnswers || a.sentence - b.sentence);
  positive.sort((a, b) => (b.reference?.length ?? 0) - (a.reference?.length ?? 0) || a.sentence - b.sentence);
  const ordered = [...still, ...corrected, ...positive.slice(0, MAX_POSITIVE_EVIDENCE), ...unavailable];

  const individual: EvidenceItem[] = [];
  let used = 0;
  for (const item of ordered) {
    const size = JSON.stringify(item).length;
    if (used + size > charBudget) break;
    individual.push(item);
    used += size;
  }
  const rest = ordered.slice(individual.length);
  const aggregates = { sentences: rest.length, byKind: {} as Record<string, number>, byDifference: {} as Record<string, number> };
  for (const item of rest) {
    aggregates.byKind[item.kind] = (aggregates.byKind[item.kind] ?? 0) + 1;
    for (const d of item.differences) {
      const label = d.split(":")[0].split("“")[0].trim() || "Words differ";
      aggregates.byDifference[label] = (aggregates.byDifference[label] ?? 0) + 1;
    }
  }

  // ---- explanation targets (P4 identity), priority order
  const groups = new Map<string, ExplanationTarget>();
  for (const item of [...still, ...corrected]) {
    const ev = evBy.get(item.sentence - 1);
    const answer = item.kind === "currently_incorrect" ? ev?.latest : ev?.lastWrong;
    const row = answer ? byId.get(answer.attemptId) : undefined;
    if (!row || row.is_correct || row.user_text === null) continue;
    if (isSpacingOnly(row.expected_text, row.user_text)) continue;
    const key = explanationPatternKey(row.expected_text, row.user_text, row.match_mode) ?? `attempt:${row.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.segmentIndexes.push(row.segment_index);
      continue;
    }
    groups.set(key, {
      attemptId: row.id,
      segmentIndexes: [row.segment_index],
      kind: item.kind as "currently_incorrect" | "corrected",
      reference: row.expected_text,
      answer: row.user_text,
      matchRule: row.match_mode ?? "unknown",
      covered: false,
    });
  }
  const targets = [...groups.values()];
  const asAttempt = (a: AssessmentAttemptRow): ExplanationAttempt => ({
    id: a.id,
    segment_index: a.segment_index,
    expected_text: a.expected_text,
    user_text: a.user_text ?? "",
    match_mode: a.match_mode,
    is_correct: a.is_correct,
    created_at: a.created_at,
  });
  const roundAttempts = attempts.map(asAttempt);
  const covered = coveredAttemptIds(targets.map((t) => asAttempt(byId.get(t.attemptId)!)), roundAttempts, notes);
  for (const t of targets) t.covered = covered.has(t.attemptId);

  // ---- learning-data fingerprint: the data an assessment is based on
  const valid = attempts
    .filter((a) => a.is_practice_valid !== false)
    .map((a) => [a.id, a.is_correct] as const)
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        transcriptId: report.round.transcriptId,
        eligible: metrics.eligibleSentences,
        historyComplete: metrics.historyComplete,
        valid,
      })
    )
    .digest("hex");

  return { metrics, evidence: ordered, individual, aggregates, targets, missingTargets: targets.filter((t) => !t.covered), fingerprint, charBudget };
}

/**
 * The targets of one request: the next ≤ batch missing ones in priority
 * order, or — when sentences are selected (0-based) — the targets covering
 * those sentences (still ≤ batch). Never more than one batch: there is no
 * automatic loop. `onlyMissing` keeps ordinary requests from re-paying for
 * saved notes; re-explanation passes false explicitly.
 */
export function selectBatch(input: AssessmentInput, batchSize: number, opts: { sentences?: number[]; onlyMissing: boolean }): ExplanationTarget[] {
  const limit = Math.min(batchSize, MAX_EXPLANATION_BATCH);
  const pool = opts.onlyMissing ? input.missingTargets : input.targets;
  if (opts.sentences && opts.sentences.length > 0) {
    const want = new Set(opts.sentences);
    return pool.filter((t) => t.segmentIndexes.some((s) => want.has(s))).slice(0, limit);
  }
  return pool.slice(0, limit);
}
