"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadShadowingEvaluations,
  saveShadowingEvaluations,
  type ShadowingEvaluationMap,
} from "./shadowingEvaluationPersistence";
import { stripEdgePunctuation } from "./helpers";
import type { EvaluationProblemWord, SentenceEvaluation, TrueEvaluationWord } from "./types";

/** One entry in the session-wide, ranked "words to practice" list — Azure
 *  pronunciation data only (Word Match's browser-diff problem words are a
 *  separate, per-sentence-only concept and are never mixed into this
 *  session-level ranking — see "Shadowing Evaluation Improvement Plan" §6.3). */
export interface ProblemWordEntry {
  word: string;
  avgScore: number;
  sentenceCount: number;
  segmentIndexes: number[];
}

export interface WeakestSentence {
  segmentIndex: number;
  referenceText: string;
  /** Azure's own PronScore when available, else a fallback accuracy score —
   *  see rankingScoreFor(). This is always the number displayed/sorted by. */
  score: number;
  usedFallbackScore: boolean;
  problemWordCount: number;
}

export interface ShadowingEvaluationSummary {
  evaluatedCount: number;
  totalCount: number;
  notEvaluatedCount: number;
  weightedAccuracy: number | null;
  weightedFluency: number | null;
  weightedCompleteness: number | null;
  weightedProsody: number | null;
  problemWords: ProblemWordEntry[];
  weakestSentences: WeakestSentence[];
}

const WEAKEST_SENTENCE_LIMIT = 5;
const PROBLEM_WORD_LIMIT = 12;
/** Recurrence is capped before multiplying into the rank score so a word
 *  that's weak in many sentences doesn't dominate purely by volume — see
 *  rankProblemWords() below. */
const PROBLEM_WORD_RECURRENCE_CAP = 5;

function weightedAverage(entries: Array<{ value: number; weight: number }>): number | null {
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  if (totalWeight <= 0) return null;
  const weightedSum = entries.reduce((sum, e) => sum + e.value * e.weight, 0);
  return weightedSum / totalWeight;
}

function baseEntry(
  prev: SentenceEvaluation | undefined,
  segmentIndex: number,
  meta: { referenceText: string; wordCount: number; audioDuration: number }
): SentenceEvaluation {
  return {
    segmentIndex,
    referenceText: meta.referenceText,
    wordCount: meta.wordCount,
    audioDuration: meta.audioDuration,
    wordMatch: prev?.wordMatch,
    trueEvaluation: prev?.trueEvaluation,
    lastSuccessfulTrueEvaluation: prev?.lastSuccessfulTrueEvaluation,
  };
}

/** Prefers the last *successful* True Evaluation's real scores — never the
 *  in-flight/failed `trueEvaluation` attempt — falling back to Word Match's
 *  diff-derived accuracy/completeness stand-in only when no True Evaluation
 *  has ever succeeded for this sentence. Fluency/Prosody only ever come
 *  from True Evaluation — Word Match has no equivalent. Reading from
 *  lastSuccessfulTrueEvaluation (rather than trueEvaluation) is what makes a
 *  failed retry keep the previous score in every aggregate that uses this. */
function scoresFor(entry: SentenceEvaluation) {
  const te = entry.lastSuccessfulTrueEvaluation;
  const wm = entry.wordMatch?.status === "completed" ? entry.wordMatch : undefined;
  return {
    accuracy: te?.accuracyScore ?? wm?.accuracy,
    completeness: te?.completenessScore ?? wm?.completeness,
    fluency: te?.fluencyScore,
    prosody: te?.prosodyScore,
  };
}

/** The score used to rank/display a sentence in "lowest-scoring sentences" —
 *  Azure's own PronScore when available (documented as the ranking source
 *  of truth), falling back to the accuracy sub-metric (True Eval or Word
 *  Match) when PronScore wasn't returned for this sentence. */
function rankingScoreFor(entry: SentenceEvaluation): { score: number; usedFallback: boolean } | null {
  const pronScore = entry.lastSuccessfulTrueEvaluation?.pronunciationScore;
  if (pronScore !== undefined) return { score: pronScore, usedFallback: false };
  const accuracy = scoresFor(entry).accuracy;
  if (accuracy !== undefined) return { score: accuracy, usedFallback: true };
  return null;
}

/** Normalizes a raw Azure word for session-level aggregation: lowercase,
 *  edge punctuation stripped (reusing the same stripEdgePunctuation() used
 *  for script rendering elsewhere), empty/punctuation-only tokens dropped.
 *  Function words are intentionally NOT filtered out here — see
 *  rankProblemWords() for how a one-off weak function word is kept from
 *  outranking a repeatedly-weak content word instead. */
function normalizeProblemWord(rawWord: string): string | null {
  const stripped = stripEdgePunctuation(rawWord).toLowerCase();
  return stripped.length > 0 ? stripped : null;
}

/** Every *Azure* (True Evaluation) word flagged with a non-"None" error type
 *  for one sentence — Word Match's browser-diff problem words are
 *  deliberately excluded from this session-level aggregation (they're a
 *  separate, lower-confidence signal shown only per-sentence in the Word
 *  Match card itself, never blended into pronunciation ranking). */
function azureProblemWordsFor(entry: SentenceEvaluation): Array<{ word: string; score: number }> {
  const words: TrueEvaluationWord[] = entry.lastSuccessfulTrueEvaluation?.words ?? [];
  const seen = new Set<string>();
  const result: Array<{ word: string; score: number }> = [];
  for (const w of words) {
    if (!w.errorType || w.errorType === "None") continue;
    if (w.accuracyScore === null || w.accuracyScore === undefined) continue;
    const key = normalizeProblemWord(w.word);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ word: key, score: w.accuracyScore });
  }
  return result;
}

/** Aggregates per-sentence Azure problem words into a session-wide ranked
 *  list. Rank formula (documented so it's both testable and explainable):
 *  `rankScore = (100 - avgScore) * min(sentenceCount, RECURRENCE_CAP)` —
 *  severity (how low the average score is) multiplied by capped recurrence,
 *  so a word that's very weak in one sentence can still outrank a mildly
 *  weak word that recurs often, but recurrence is capped so a common,
 *  slightly-weak function word can't out-rank a severely-weak content word
 *  purely by appearing in many sentences. */
export function rankProblemWords(
  entries: Array<{ segmentIndex: number; words: Array<{ word: string; score: number }> }>
): ProblemWordEntry[] {
  const byWord = new Map<string, { totalScore: number; occurrences: number; segmentIndexes: Set<number> }>();
  for (const entry of entries) {
    for (const { word, score } of entry.words) {
      const bucket = byWord.get(word) ?? { totalScore: 0, occurrences: 0, segmentIndexes: new Set<number>() };
      bucket.totalScore += score;
      bucket.occurrences += 1;
      bucket.segmentIndexes.add(entry.segmentIndex);
      byWord.set(word, bucket);
    }
  }

  return Array.from(byWord.entries())
    .map(([word, bucket]) => {
      const avgScore = bucket.totalScore / bucket.occurrences;
      const sentenceCount = bucket.segmentIndexes.size;
      const rankScore = (100 - avgScore) * Math.min(sentenceCount, PROBLEM_WORD_RECURRENCE_CAP);
      return {
        word,
        avgScore,
        sentenceCount,
        segmentIndexes: Array.from(bucket.segmentIndexes).sort((a, b) => a - b),
        rankScore,
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, PROBLEM_WORD_LIMIT)
    .map(({ word, avgScore, sentenceCount, segmentIndexes }) => ({ word, avgScore, sentenceCount, segmentIndexes }));
}

/**
 * Owns the per-video sessionStorage-backed map of SentenceEvaluations and
 * derives the session summary live from whatever's in it — see "Shadowing
 * and Pronunciation Practice Plan.md" §11. Lives in page.tsx (a stable
 * parent that stays mounted across right-panel tab switches), not inside
 * EvaluationTab, so Word Match and True Evaluation results — two
 * independent, nested results per sentence — survive switching tabs,
 * switching sentences, and a same-tab refresh (rehydrated once on mount).
 */
export function useShadowingEvaluations(videoId: string, transcriptId: string | null | undefined, totalCount: number) {
  const [evaluations, setEvaluations] = useState<ShadowingEvaluationMap>({});

  useEffect(() => {
    setEvaluations(loadShadowingEvaluations(videoId, transcriptId));
  }, [videoId, transcriptId]);

  const updateEntry = useCallback(
    (segmentIndex: number, updater: (prev: SentenceEvaluation | undefined) => SentenceEvaluation) => {
      setEvaluations((prev) => {
        const next = { ...prev, [segmentIndex]: updater(prev[segmentIndex]) };
        saveShadowingEvaluations(videoId, transcriptId, next);
        return next;
      });
    },
    [videoId, transcriptId]
  );

  type EvaluationMeta = { referenceText: string; wordCount: number; audioDuration: number };

  const startWordMatch = useCallback(
    (segmentIndex: number, meta: EvaluationMeta) => {
      updateEntry(segmentIndex, (prev) => ({
        ...baseEntry(prev, segmentIndex, meta),
        wordMatch: { status: "processing" },
      }));
    },
    [updateEntry]
  );

  const completeWordMatch = useCallback(
    (
      segmentIndex: number,
      data: {
        recognizedText: string;
        accuracy: number;
        completeness: number;
        problemWords: EvaluationProblemWord[];
      }
    ) => {
      updateEntry(segmentIndex, (prev) => ({
        ...(prev ?? { segmentIndex, referenceText: "", wordCount: 0, audioDuration: 0 }),
        wordMatch: { status: "completed", ...data },
      }));
    },
    [updateEntry]
  );

  const failWordMatch = useCallback(
    (segmentIndex: number, error: string) => {
      updateEntry(segmentIndex, (prev) => ({
        ...(prev ?? { segmentIndex, referenceText: "", wordCount: 0, audioDuration: 0 }),
        wordMatch: { status: "failed", error },
      }));
    },
    [updateEntry]
  );

  const markWordMatchUnsupported = useCallback(
    (segmentIndex: number, meta: EvaluationMeta) => {
      updateEntry(segmentIndex, (prev) => ({
        ...baseEntry(prev, segmentIndex, meta),
        wordMatch: { status: "unsupported" },
      }));
    },
    [updateEntry]
  );

  // Deliberately does NOT touch lastSuccessfulTrueEvaluation — only
  // `trueEvaluation` (the current-attempt status machine) is reset to
  // "processing" here, so a previous successful score is never wiped just
  // because a new evaluation started (see the "retry destroys previous
  // result" bug fix in the improvement plan §6.1).
  const startTrueEvaluation = useCallback(
    (segmentIndex: number, meta: EvaluationMeta) => {
      updateEntry(segmentIndex, (prev) => ({
        ...baseEntry(prev, segmentIndex, meta),
        trueEvaluation: { status: "processing" },
      }));
    },
    [updateEntry]
  );

  const completeTrueEvaluation = useCallback(
    (
      segmentIndex: number,
      data: Omit<NonNullable<SentenceEvaluation["trueEvaluation"]>, "status" | "error">
    ) => {
      updateEntry(segmentIndex, (prev) => {
        const completed = { status: "completed" as const, evaluatedAt: new Date().toISOString(), ...data };
        return {
          ...(prev ?? { segmentIndex, referenceText: "", wordCount: 0, audioDuration: 0 }),
          trueEvaluation: completed,
          lastSuccessfulTrueEvaluation: completed,
        };
      });
    },
    [updateEntry]
  );

  // Deliberately does NOT touch lastSuccessfulTrueEvaluation — a failed
  // retry keeps whatever the previous successful evaluation was, so the UI
  // and session aggregation can keep showing it (see plan §6.1/§9).
  const failTrueEvaluation = useCallback(
    (segmentIndex: number, error: string, status: "failed" | "unavailable" = "failed") => {
      updateEntry(segmentIndex, (prev) => ({
        ...(prev ?? { segmentIndex, referenceText: "", wordCount: 0, audioDuration: 0 }),
        trueEvaluation: { status, error },
      }));
    },
    [updateEntry]
  );

  const summary = useMemo<ShadowingEvaluationSummary>(() => {
    // A sentence counts as "evaluated" once it has a completed Word Match OR
    // a True Evaluation that has ever succeeded (lastSuccessfulTrueEvaluation)
    // — a currently-failed/processing attempt does not un-count a sentence
    // that previously succeeded, and a bare failure with no prior success
    // never counts at all.
    const entries = Object.values(evaluations).filter(
      (e) => e.wordMatch?.status === "completed" || !!e.lastSuccessfulTrueEvaluation
    );
    const evaluatedCount = entries.length;

    const accuracyEntries: Array<{ value: number; weight: number }> = [];
    const completenessEntries: Array<{ value: number; weight: number }> = [];
    const fluencyEntries: Array<{ value: number; weight: number }> = [];
    const prosodyEntries: Array<{ value: number; weight: number }> = [];
    const problemWordInputs: Array<{ segmentIndex: number; words: Array<{ word: string; score: number }> }> = [];
    const weakestSentences: WeakestSentence[] = [];

    for (const entry of entries) {
      const scores = scoresFor(entry);
      if (scores.accuracy !== undefined) accuracyEntries.push({ value: scores.accuracy, weight: entry.wordCount });
      if (scores.completeness !== undefined)
        completenessEntries.push({ value: scores.completeness, weight: entry.wordCount });
      if (scores.fluency !== undefined) fluencyEntries.push({ value: scores.fluency, weight: entry.audioDuration });
      if (scores.prosody !== undefined) prosodyEntries.push({ value: scores.prosody, weight: entry.audioDuration });

      const azureWords = azureProblemWordsFor(entry);
      if (azureWords.length > 0) problemWordInputs.push({ segmentIndex: entry.segmentIndex, words: azureWords });

      const ranking = rankingScoreFor(entry);
      if (ranking) {
        weakestSentences.push({
          segmentIndex: entry.segmentIndex,
          referenceText: entry.referenceText,
          score: ranking.score,
          usedFallbackScore: ranking.usedFallback,
          problemWordCount: azureWords.length,
        });
      }
    }

    const problemWords = rankProblemWords(problemWordInputs);

    weakestSentences.sort((a, b) => a.score - b.score || b.problemWordCount - a.problemWordCount);

    return {
      evaluatedCount,
      totalCount,
      notEvaluatedCount: Math.max(0, totalCount - evaluatedCount),
      weightedAccuracy: weightedAverage(accuracyEntries),
      weightedFluency: weightedAverage(fluencyEntries),
      weightedCompleteness: weightedAverage(completenessEntries),
      weightedProsody: weightedAverage(prosodyEntries),
      problemWords,
      weakestSentences: weakestSentences.slice(0, WEAKEST_SENTENCE_LIMIT),
    };
  }, [evaluations, totalCount]);

  return {
    evaluations,
    summary,
    startWordMatch,
    completeWordMatch,
    failWordMatch,
    markWordMatchUnsupported,
    startTrueEvaluation,
    completeTrueEvaluation,
    failTrueEvaluation,
  };
}
