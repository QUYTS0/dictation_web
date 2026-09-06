"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadShadowingEvaluations,
  saveShadowingEvaluations,
  type ShadowingEvaluationMap,
} from "./shadowingEvaluationPersistence";
import { buildShadowingEvaluationSummary, toAttempt } from "./videoPracticeSummary";
import type { EvaluationProblemWord, SentenceEvaluation, SentenceEvaluationAttempt } from "./types";

export type {
  ImprovementEvent,
  PhonemePracticeStat,
  ShadowingEvaluationSummary,
  WeakestSentence,
  WordPracticeStat,
} from "./videoPracticeSummary";

/** Retried attempts beyond this many are dropped oldest-first — see
 *  "Video-wide learning history" plan §2. Historical attempts are compact
 *  (scores + light per-word scores only, no phonemes/raw Azure data), so
 *  this cap keeps sessionStorage growth bounded without needing IndexedDB. */
const MAX_ATTEMPTS_PER_SENTENCE = 5;

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
    attempts: prev?.attempts,
  };
}

/**
 * Owns the per-video sessionStorage-backed map of SentenceEvaluations and
 * derives the session summary live from whatever's in it — see "Shadowing
 * and Pronunciation Practice Plan.md" §11 and the "Video-wide learning
 * history" plan for the attempts/summary design. Lives in page.tsx (a
 * stable parent that stays mounted across right-panel tab switches), not
 * inside EvaluationTab, so Word Match and True Evaluation results — two
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

  // Deliberately does NOT touch lastSuccessfulTrueEvaluation/attempts — only
  // `trueEvaluation` (the current-attempt status machine) is reset to
  // "processing" here, so a previous successful score (and its history) is
  // never wiped just because a new evaluation started (see the "retry
  // destroys previous result" bug fix in the improvement plan §6.1).
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
        // A retry no longer destroys the previous result: every completed
        // attempt is appended to a capped history (compact — no phonemes/
        // raw Azure data, see toAttempt()) so trend/improvement detection
        // can see the whole 32 -> 48 -> 67 -> 86 arc, not just the latest
        // point. Old records without `attempts` synthesize a one-point
        // history from whatever lastSuccessfulTrueEvaluation already held.
        const priorAttempts: SentenceEvaluationAttempt[] =
          prev?.attempts ?? (prev?.lastSuccessfulTrueEvaluation ? [toAttempt(prev.lastSuccessfulTrueEvaluation)] : []);
        const attempts = [...priorAttempts, toAttempt(completed)].slice(-MAX_ATTEMPTS_PER_SENTENCE);
        return {
          ...(prev ?? { segmentIndex, referenceText: "", wordCount: 0, audioDuration: 0 }),
          trueEvaluation: completed,
          lastSuccessfulTrueEvaluation: completed,
          attempts,
        };
      });
    },
    [updateEntry]
  );

  // Deliberately does NOT touch lastSuccessfulTrueEvaluation/attempts — a
  // failed retry keeps whatever the previous successful evaluation and
  // history were, so the UI and session aggregation can keep showing them
  // (see plan §6.1/§9) and a failed request never pollutes a trend with a
  // phantom low score.
  const failTrueEvaluation = useCallback(
    (segmentIndex: number, error: string, status: "failed" | "unavailable" = "failed") => {
      updateEntry(segmentIndex, (prev) => ({
        ...(prev ?? { segmentIndex, referenceText: "", wordCount: 0, audioDuration: 0 }),
        trueEvaluation: { status, error },
      }));
    },
    [updateEntry]
  );

  const summary = useMemo(() => buildShadowingEvaluationSummary(evaluations, totalCount), [evaluations, totalCount]);

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
