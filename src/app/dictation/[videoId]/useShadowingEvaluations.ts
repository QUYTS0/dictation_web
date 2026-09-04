"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadShadowingEvaluations,
  saveShadowingEvaluations,
  type ShadowingEvaluationMap,
} from "./shadowingEvaluationPersistence";
import type { SentenceEvaluation } from "./types";

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

/**
 * Owns the per-video sessionStorage-backed map of SentenceEvaluations and
 * derives the session summary live from whatever's in it — see "Shadowing
 * and Pronunciation Practice Plan.md" §11. Accuracy/completeness are
 * word-count weighted, fluency/prosody are audio-duration weighted;
 * categories no evaluation produced a value for resolve to null rather than
 * 0, so the summary UI can omit them instead of showing a fake zero.
 */
export function useShadowingEvaluations(videoId: string, totalCount: number) {
  const [evaluations, setEvaluations] = useState<ShadowingEvaluationMap>({});

  useEffect(() => {
    setEvaluations(loadShadowingEvaluations(videoId));
  }, [videoId]);

  const recordEvaluation = useCallback(
    (evaluation: SentenceEvaluation) => {
      setEvaluations((prev) => {
        const next = { ...prev, [evaluation.segmentIndex]: evaluation };
        saveShadowingEvaluations(videoId, next);
        return next;
      });
    },
    [videoId]
  );

  const summary = useMemo<ShadowingEvaluationSummary>(() => {
    const entries = Object.values(evaluations);
    const evaluatedCount = entries.length;

    const accuracyEntries = entries
      .filter((e): e is SentenceEvaluation & { accuracy: number } => e.accuracy !== undefined)
      .map((e) => ({ value: e.accuracy, weight: e.wordCount }));
    const completenessEntries = entries
      .filter((e): e is SentenceEvaluation & { completeness: number } => e.completeness !== undefined)
      .map((e) => ({ value: e.completeness, weight: e.wordCount }));
    const fluencyEntries = entries
      .filter((e): e is SentenceEvaluation & { fluency: number } => e.fluency !== undefined)
      .map((e) => ({ value: e.fluency, weight: e.audioDuration }));
    const prosodyEntries = entries
      .filter((e): e is SentenceEvaluation & { prosody: number } => e.prosody !== undefined)
      .map((e) => ({ value: e.prosody, weight: e.audioDuration }));

    const problemWordTally = new Map<string, number>();
    for (const entry of entries) {
      for (const problem of entry.problemWords ?? []) {
        const key = problem.word.toLowerCase();
        problemWordTally.set(key, (problemWordTally.get(key) ?? 0) + 1);
      }
    }
    const problemWords = Array.from(problemWordTally.entries())
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, PROBLEM_WORD_LIMIT);

    const weakestSentences = entries
      .filter((e): e is SentenceEvaluation & { accuracy: number } => e.accuracy !== undefined)
      .map((e) => ({
        segmentIndex: e.segmentIndex,
        referenceText: e.referenceText,
        accuracy: e.accuracy,
        problemWordCount: e.problemWords?.length ?? 0,
      }))
      .sort((a, b) => a.accuracy - b.accuracy || b.problemWordCount - a.problemWordCount)
      .slice(0, WEAKEST_SENTENCE_LIMIT);

    return {
      evaluatedCount,
      totalCount,
      notEvaluatedCount: Math.max(0, totalCount - evaluatedCount),
      weightedAccuracy: weightedAverage(accuracyEntries),
      weightedCompleteness: weightedAverage(completenessEntries),
      weightedFluency: weightedAverage(fluencyEntries),
      weightedProsody: weightedAverage(prosodyEntries),
      problemWords,
      weakestSentences,
    };
  }, [evaluations, totalCount]);

  return { evaluations, recordEvaluation, summary };
}
