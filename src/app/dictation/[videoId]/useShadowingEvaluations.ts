"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  acceptsOrigin,
  loadShadowingEvaluations,
  saveShadowingEvaluations,
  scopeKey,
  type ShadowingCacheScope,
  type ShadowingEvaluationMap,
} from "./shadowingEvaluationPersistence";
import { mergeServerResults } from "./shadowingServerMerge";
import { fetchRoundShadowingResults } from "./shadowingApi";
import { buildShadowingEvaluationSummary, toAttempt } from "./videoPracticeSummary";
import type {
  EvaluationProblemWord,
  ResultPersistence,
  SentenceEvaluation,
  SentenceEvaluationAttempt,
} from "./types";

export type {
  ImprovementEvent,
  PhonemePracticeStat,
  ShadowingEvaluationSummary,
  WeakestSentence,
  WordPracticeStat,
} from "./videoPracticeSummary";

/** Retried attempts beyond this many are dropped oldest-first — a
 *  DISPLAY/cache cap only (plan §6.7): the server keeps every attempt, and
 *  a reload restores up to this many per sentence from it. */
const MAX_ATTEMPTS_PER_SENTENCE = 5;

function baseEntry(
  prev: SentenceEvaluation | undefined,
  segmentIndex: number,
  meta: { referenceText: string; wordCount: number; audioDuration: number }
): SentenceEvaluation {
  return {
    ...prev,
    segmentIndex,
    referenceText: meta.referenceText,
    wordCount: meta.wordCount,
    audioDuration: meta.audioDuration,
  };
}

function emptyEntry(segmentIndex: number): SentenceEvaluation {
  return { segmentIndex, referenceText: "", wordCount: 0, audioDuration: 0 };
}

function withSavedEvaluation(prev: SentenceEvaluation | undefined, segmentIndex: number, completed: NonNullable<SentenceEvaluation["trueEvaluation"]>) {
  // A retry no longer destroys the previous result: every SAVED completed
  // attempt is appended to a capped history. Old records without
  // `attempts` synthesize a one-point history from lastSuccessfulTrueEvaluation.
  const priorAttempts: SentenceEvaluationAttempt[] =
    prev?.attempts ?? (prev?.lastSuccessfulTrueEvaluation ? [toAttempt(prev.lastSuccessfulTrueEvaluation)] : []);
  const alreadyThere = !!completed.attemptId && priorAttempts.some((a) => a.attemptId === completed.attemptId);
  const attempts = (alreadyThere ? priorAttempts : [...priorAttempts, toAttempt(completed)]).slice(-MAX_ATTEMPTS_PER_SENTENCE);
  return {
    ...(prev ?? emptyEntry(segmentIndex)),
    trueEvaluation: completed,
    lastSuccessfulTrueEvaluation: completed,
    attempts,
  };
}

export interface ShadowingEvaluationsOptions {
  videoId: string;
  transcriptId: string | null | undefined;
  /** Signed-in user (null for a visitor — nothing is loaded from/saved to the server). */
  userId: string | null;
  /** The round the page is showing (null until known). */
  roundId: string | null | undefined;
  totalCount: number;
  /** The sentence text for a segment index (for entries restored from the server). */
  referenceTextFor: (segmentIndex: number) => string;
}

/**
 * Owns the per-sentence Shadowing map (Word Match + Pronunciation, each
 * independent) for ONE scope — (user, video, transcript revision, round) —
 * and derives the session summary from it.
 *
 * Phase 4: the server is the source of truth. On every scope change the
 * scoped sessionStorage cache is shown immediately, then the round's saved
 * results are fetched and reconciled (shadowingServerMerge.ts) — so a
 * reload restores results even with an empty cache, and a stale cache never
 * overrides the server. Every mutator takes the scope key it was started
 * in: a late callback from another video/round/account is ignored instead
 * of landing on whatever the page shows now (the server-side write it
 * belongs to is keyed by attempt id and is unaffected).
 */
export function useShadowingEvaluations(options: ShadowingEvaluationsOptions) {
  const { videoId, transcriptId, userId, roundId, totalCount, referenceTextFor } = options;
  const scope: ShadowingCacheScope = useMemo(
    () => ({ userId, videoId, transcriptId, roundId }),
    [userId, videoId, transcriptId, roundId]
  );
  const key = scopeKey(scope);
  const [state, setState] = useState<{ key: string; evaluations: ShadowingEvaluationMap }>(() => ({
    key,
    evaluations: {},
  }));
  const [serverLoadError, setServerLoadError] = useState<string | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const referenceTextRef = useRef(referenceTextFor);
  referenceTextRef.current = referenceTextFor;
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ key, evaluations: loadShadowingEvaluations(scope) });
    setServerLoadError(null);
    if (!userId || !roundId || !transcriptId) return;
    fetchRoundShadowingResults(roundId)
      .then((server) => {
        if (cancelled || keyRef.current !== key) return;
        // A round pinned to another revision than the one displayed would
        // attach results to the wrong sentences — never merge it.
        if (server.transcriptId !== transcriptId) return;
        setState((prev) => {
          if (prev.key !== key) return prev;
          const merged = mergeServerResults(prev.evaluations, server, (i) => referenceTextRef.current(i));
          saveShadowingEvaluations(scope, merged);
          return { key, evaluations: merged };
        });
      })
      .catch(() => {
        if (cancelled || keyRef.current !== key) return;
        setServerLoadError("Couldn't load your saved recordings. Showing what this tab still has.");
      });
    return () => {
      cancelled = true;
    };
    // `scope` is derived from exactly these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reloadToken]);

  const evaluations = useMemo<ShadowingEvaluationMap>(() => (state.key === key ? state.evaluations : {}), [state, key]);

  const updateEntry = useCallback(
    (origin: string, segmentIndex: number, updater: (prev: SentenceEvaluation | undefined) => SentenceEvaluation) => {
      if (!acceptsOrigin(origin, keyRef.current)) return;
      setState((prev) => {
        if (!acceptsOrigin(origin, prev.key)) return prev;
        const next = { ...prev.evaluations, [segmentIndex]: updater(prev.evaluations[segmentIndex]) };
        saveShadowingEvaluations(scope, next);
        return { key: prev.key, evaluations: next };
      });
    },
    [scope]
  );

  type EvaluationMeta = { referenceText: string; wordCount: number; audioDuration: number };

  const startWordMatch = useCallback(
    (origin: string, segmentIndex: number, meta: EvaluationMeta) => {
      updateEntry(origin, segmentIndex, (prev) => ({ ...baseEntry(prev, segmentIndex, meta), wordMatch: { status: "processing" } }));
    },
    [updateEntry]
  );

  const completeWordMatch = useCallback(
    (
      origin: string,
      segmentIndex: number,
      data: {
        recognizedText: string;
        accuracy: number;
        completeness: number;
        problemWords: EvaluationProblemWord[];
        attemptId?: string;
        clipId?: string;
        persisted?: boolean;
      }
    ) => {
      updateEntry(origin, segmentIndex, (prev) => ({ ...(prev ?? emptyEntry(segmentIndex)), wordMatch: { status: "completed", ...data } }));
    },
    [updateEntry]
  );

  /** The server's answer for a Word Match of `attemptId` (only if that is
   *  still the result shown for the sentence). */
  const setWordMatchPersisted = useCallback(
    (origin: string, segmentIndex: number, take: { clipUrl: string; attemptId: string }, persisted: boolean) => {
      updateEntry(origin, segmentIndex, (prev) => {
        const wm = prev?.wordMatch;
        if (!wm || wm.status !== "completed" || (wm.attemptId !== take.attemptId && wm.clipId !== take.clipUrl)) {
          return prev ?? emptyEntry(segmentIndex);
        }
        return { ...prev!, wordMatch: { ...wm, attemptId: take.attemptId, persisted } };
      });
    },
    [updateEntry]
  );

  const failWordMatch = useCallback(
    (origin: string, segmentIndex: number, error: string) => {
      updateEntry(origin, segmentIndex, (prev) => ({ ...(prev ?? emptyEntry(segmentIndex)), wordMatch: { status: "failed", error } }));
    },
    [updateEntry]
  );

  const markWordMatchUnsupported = useCallback(
    (origin: string, segmentIndex: number, meta: EvaluationMeta) => {
      updateEntry(origin, segmentIndex, (prev) => ({ ...baseEntry(prev, segmentIndex, meta), wordMatch: { status: "unsupported" } }));
    },
    [updateEntry]
  );

  // Deliberately does NOT touch lastSuccessfulTrueEvaluation/attempts — only
  // `trueEvaluation` (the current-attempt status machine) is reset, so a
  // previous successful score is never wiped just because a new one started.
  const startTrueEvaluation = useCallback(
    (origin: string, segmentIndex: number, meta: EvaluationMeta) => {
      updateEntry(origin, segmentIndex, (prev) => ({ ...baseEntry(prev, segmentIndex, meta), trueEvaluation: { status: "processing" } }));
    },
    [updateEntry]
  );

  const completeTrueEvaluation = useCallback(
    (
      origin: string,
      segmentIndex: number,
      data: Omit<NonNullable<SentenceEvaluation["trueEvaluation"]>, "status" | "error">
    ) => {
      updateEntry(origin, segmentIndex, (prev) => {
        const completed = { status: "completed" as const, evaluatedAt: new Date().toISOString(), ...data };
        // Only a SAVED result (or a visitor's local-only one) becomes the
        // sentence's last successful score and feeds the summary; an unsaved
        // or superseded one is shown for this take but never promoted.
        if (completed.persistence === "unsaved" || completed.persistence === "superseded") {
          return { ...(prev ?? emptyEntry(segmentIndex)), trueEvaluation: completed };
        }
        return withSavedEvaluation(prev, segmentIndex, completed);
      });
    },
    [updateEntry]
  );

  /** Marks the shown result of `attemptId` as saved/unsaved/superseded
   *  (after a recovery). Saving it promotes it to the last successful score. */
  const setTrueEvaluationPersistence = useCallback(
    (origin: string, segmentIndex: number, attemptId: string, persistence: ResultPersistence) => {
      updateEntry(origin, segmentIndex, (prev) => {
        const te = prev?.trueEvaluation;
        if (!te || te.status !== "completed" || te.attemptId !== attemptId) return prev ?? emptyEntry(segmentIndex);
        const updated = { ...te, persistence };
        return persistence === "saved" ? withSavedEvaluation(prev, segmentIndex, updated) : { ...prev!, trueEvaluation: updated };
      });
    },
    [updateEntry]
  );

  // Deliberately does NOT touch lastSuccessfulTrueEvaluation/attempts — a
  // failed retry keeps the previous successful evaluation and history.
  const failTrueEvaluation = useCallback(
    (origin: string, segmentIndex: number, error: string, status: "failed" | "unavailable" = "failed") => {
      updateEntry(origin, segmentIndex, (prev) => ({ ...(prev ?? emptyEntry(segmentIndex)), trueEvaluation: { status, error } }));
    },
    [updateEntry]
  );

  const reloadFromServer = useCallback(() => setReloadToken((n) => n + 1), []);

  const summary = useMemo(() => buildShadowingEvaluationSummary(evaluations, totalCount), [evaluations, totalCount]);

  return {
    scopeKey: key,
    evaluations,
    summary,
    serverLoadError,
    reloadFromServer,
    startWordMatch,
    completeWordMatch,
    setWordMatchPersisted,
    failWordMatch,
    markWordMatchUnsupported,
    startTrueEvaluation,
    completeTrueEvaluation,
    setTrueEvaluationPersistence,
    failTrueEvaluation,
  };
}
