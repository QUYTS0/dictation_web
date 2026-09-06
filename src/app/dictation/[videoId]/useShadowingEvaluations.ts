"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadShadowingEvaluations,
  saveShadowingEvaluations,
  type ShadowingEvaluationMap,
} from "./shadowingEvaluationPersistence";
import type { EvaluationProblemWord, SentenceEvaluation } from "./types";

export interface ProblemWordTally {
  word: string;
  count: number;
}

export interface WeakestSentence {
  segmentIndex: number;
  referenceText: string;
  accuracy: number;
  problemWordCount: number;
}

export interface ShadowingEvaluationSummary {
  evaluatedCount: number;
  totalCount: number;
  notEvaluatedCount: number;
  weightedAccuracy: number | null;
  weightedCompleteness: number | null;
  weightedFluency: number | null;
  weightedProsody: number | null;
  problemWords: ProblemWordTally[];
  weakestSentences: WeakestSentence[];
}

const WEAKEST_SENTENCE_LIMIT = 5;
const PROBLEM_WORD_LIMIT = 12;

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
  };
}

/** Every completed result's problem words for one sentence, deduped by word
 *  (a word flagged by both Word Match and True Evaluation counts once). */
function problemWordsFor(entry: SentenceEvaluation): EvaluationProblemWord[] {
  const byWord = new Map<string, EvaluationProblemWord>();
  if (entry.trueEvaluation?.status === "completed") {
    for (const w of entry.trueEvaluation.words ?? []) {
      if (!w.errorType || w.errorType === "None") continue;
      byWord.set(w.word.toLowerCase(), { word: w.word, errorType: w.errorType, score: w.accuracyScore ?? undefined });
    }
  }
  if (entry.wordMatch?.status === "completed") {
    for (const w of entry.wordMatch.problemWords ?? []) {
      const key = w.word.toLowerCase();
      if (!byWord.has(key)) byWord.set(key, w);
    }
  }
  return Array.from(byWord.values());
}

/** Prefers True Evaluation's real scores; falls back to Word Match's
 *  diff-derived accuracy/completeness stand-in. Fluency/Prosody only ever
 *  come from True Evaluation — Word Match has no equivalent. */
function scoresFor(entry: SentenceEvaluation) {
  const te = entry.trueEvaluation?.status === "completed" ? entry.trueEvaluation : undefined;
  const wm = entry.wordMatch?.status === "completed" ? entry.wordMatch : undefined;
  return {
    accuracy: te?.accuracyScore ?? wm?.accuracy,
    completeness: te?.completenessScore ?? wm?.completeness,
    fluency: te?.fluencyScore,
    prosody: te?.prosodyScore,
  };
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
      updateEntry(segmentIndex, (prev) => ({
        ...(prev ?? { segmentIndex, referenceText: "", wordCount: 0, audioDuration: 0 }),
        trueEvaluation: { status: "completed", evaluatedAt: new Date().toISOString(), ...data },
      }));
    },
    [updateEntry]
  );

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
    const entries = Object.values(evaluations).filter(
      (e) => e.wordMatch?.status === "completed" || e.trueEvaluation?.status === "completed"
    );
    const evaluatedCount = entries.length;

    const accuracyEntries: Array<{ value: number; weight: number }> = [];
    const completenessEntries: Array<{ value: number; weight: number }> = [];
    const fluencyEntries: Array<{ value: number; weight: number }> = [];
    const prosodyEntries: Array<{ value: number; weight: number }> = [];
    const problemWordTally = new Map<string, number>();
    const weakestSentences: WeakestSentence[] = [];

    for (const entry of entries) {
      const scores = scoresFor(entry);
      if (scores.accuracy !== undefined) accuracyEntries.push({ value: scores.accuracy, weight: entry.wordCount });
      if (scores.completeness !== undefined)
        completenessEntries.push({ value: scores.completeness, weight: entry.wordCount });
      if (scores.fluency !== undefined) fluencyEntries.push({ value: scores.fluency, weight: entry.audioDuration });
      if (scores.prosody !== undefined) prosodyEntries.push({ value: scores.prosody, weight: entry.audioDuration });

      const problemWords = problemWordsFor(entry);
      for (const problem of problemWords) {
        const key = problem.word.toLowerCase();
        problemWordTally.set(key, (problemWordTally.get(key) ?? 0) + 1);
      }

      if (scores.accuracy !== undefined) {
        weakestSentences.push({
          segmentIndex: entry.segmentIndex,
          referenceText: entry.referenceText,
          accuracy: scores.accuracy,
          problemWordCount: problemWords.length,
        });
      }
    }

    const problemWords = Array.from(problemWordTally.entries())
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, PROBLEM_WORD_LIMIT);

    weakestSentences.sort((a, b) => a.accuracy - b.accuracy || b.problemWordCount - a.problemWordCount);

    return {
      evaluatedCount,
      totalCount,
      notEvaluatedCount: Math.max(0, totalCount - evaluatedCount),
      weightedAccuracy: weightedAverage(accuracyEntries),
      weightedCompleteness: weightedAverage(completenessEntries),
      weightedFluency: weightedAverage(fluencyEntries),
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
