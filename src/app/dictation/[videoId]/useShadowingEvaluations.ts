"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { summaryInputFromEvaluations, toAttempt } from "./videoPracticeSummary";
import { buildShadowingRoundSummary, compareResultOrder, type ShadowingRoundSummary } from "@/lib/practice/shadowingSummary";
import { shadowingRoundResultsKeys } from "@/lib/queries/shadowingRoundResults";
import { invalidateLearningViews } from "@/lib/queries/learningInvalidation";
import type {
  EvaluationProblemWord,
  ResultPersistence,
  SentenceEvaluation,
  SentenceEvaluationAttempt,
} from "./types";

export type { ShadowingRoundSummary } from "@/lib/practice/shadowingSummary";

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

const orderOf = (x: { createdAt?: string; recordingCreatedAt?: string; evaluatedAt?: string; attemptId?: string }) => ({
  recordingCreatedAt: x.recordingCreatedAt ?? x.createdAt ?? null,
  evaluatedAt: x.evaluatedAt ?? null,
  attemptId: x.attemptId ?? null,
});

/**
 * Adds a SAVED completed result. A retry never destroys the previous result:
 * every saved result joins a capped history (old records without `attempts`
 * synthesize a one-point history). The sentence's representative score
 * (lastSuccessfulTrueEvaluation) follows the server's canonical order —
 * latest RECORDING (created_at, then id), never the order results arrived in:
 * when both recordings' times are known, an older recording's late result
 * joins the history but does not take over.
 *
 * When the incoming recording time is unknown (a result that just arrived on
 * this page — the evaluate and recovery responses don't carry it) it is NOT
 * placed: it stays on its take's card (`trueEvaluation`, saved) and is listed
 * in `selectionPending`, while the representative score, history and every
 * summary keep the last confirmed selection. The hook re-reads the server
 * right after the save, and that read places it (or not) by the server's
 * order. The recording time is only ever taken from the SAME attempt
 * (`latestRecording` with this attempt id), never borrowed from another take.
 */
function withSavedEvaluation(prev: SentenceEvaluation | undefined, segmentIndex: number, incoming: NonNullable<SentenceEvaluation["trueEvaluation"]>) {
  const sameAttempt = <T extends { attemptId?: string }>(x: T | undefined) => !!x && !!incoming.attemptId && x.attemptId === incoming.attemptId;
  const knownTime = incoming.recordingCreatedAt
    ? undefined
    : sameAttempt(prev?.latestRecording)
      ? prev!.latestRecording!.createdAt
      : sameAttempt(prev?.lastSuccessfulTrueEvaluation)
        ? prev!.lastSuccessfulTrueEvaluation!.recordingCreatedAt
        : prev?.attempts?.find((a) => sameAttempt(a))?.createdAt;
  const completed = knownTime ? { ...incoming, recordingCreatedAt: knownTime } : incoming;
  const priorAttempts: SentenceEvaluationAttempt[] =
    prev?.attempts ?? (prev?.lastSuccessfulTrueEvaluation ? [toAttempt(prev.lastSuccessfulTrueEvaluation)] : []);
  const alreadyThere = !!completed.attemptId && priorAttempts.some((a) => a.attemptId === completed.attemptId);
  const current = prev?.lastSuccessfulTrueEvaluation;
  const pendingWithout = (prev?.selectionPending ?? []).filter((id) => id !== completed.attemptId);
  if (!completed.recordingCreatedAt && !alreadyThere && current?.attemptId !== completed.attemptId) {
    return {
      ...(prev ?? emptyEntry(segmentIndex)),
      trueEvaluation: completed,
      selectionPending: completed.attemptId ? [...pendingWithout, completed.attemptId] : pendingWithout,
    };
  }
  const olderThanCurrent =
    !!current &&
    !!current.recordingCreatedAt &&
    !!completed.recordingCreatedAt &&
    current.attemptId !== completed.attemptId &&
    compareResultOrder(orderOf(completed), orderOf(current)) < 0;
  const merged = alreadyThere ? priorAttempts : [...priorAttempts, toAttempt(completed)];
  const attempts = merged
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (x.a.createdAt && y.a.createdAt ? compareResultOrder(orderOf(x.a), orderOf(y.a)) : 0) || x.i - y.i)
    .map((x) => x.a)
    .slice(-MAX_ATTEMPTS_PER_SENTENCE);
  return {
    ...(prev ?? emptyEntry(segmentIndex)),
    trueEvaluation: completed,
    lastSuccessfulTrueEvaluation: olderThanCurrent ? current : completed,
    attempts,
    selectionPending: pendingWithout.length > 0 ? pendingWithout : undefined,
  };
}

export interface ShadowingEvaluationsOptions {
  videoId: string;
  transcriptId: string | null | undefined;
  /** Signed-in user (null for a visitor — nothing is loaded from/saved to the server). */
  userId: string | null;
  /** The round the page is showing (null until known). */
  roundId: string | null | undefined;
  /** Eligible sentences of the round's pinned revision (server); null while unknown — the summary then shows counts only. */
  eligibleSentences: number | null;
  /** Eligible sentences with a practice-valid Shadowing recording (server coverage); null while unknown. */
  recordedSentences: number | null;
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
  const { videoId, transcriptId, userId, roundId, eligibleSentences, recordedSentences, referenceTextFor } = options;
  const queryClient = useQueryClient();
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
  /** The scope whose cache was loaded: a later run for the SAME scope is a reconcile, not a page load. */
  const loadedKeyRef = useRef<string | null>(null);
  /** Monotonic counter of confirmed saves on this page, and the value each
   *  pending attempt was confirmed at: a server read places a pending result
   *  only if it STARTED after that save (an older read can't know it). */
  const saveSeqRef = useRef(0);
  const pendingSeqRef = useRef(new Map<string, number>());
  const [refreshFailed, setRefreshFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const reconcile = loadedKeyRef.current === key;
    if (!reconcile) {
      loadedKeyRef.current = key;
      setState({ key, evaluations: loadShadowingEvaluations(scope) });
      setServerLoadError(null);
      setRefreshFailed(false);
      pendingSeqRef.current.clear();
    }
    if (!userId || !roundId || !transcriptId) return;
    const readSeq = saveSeqRef.current;
    // Every run supersedes the previous one (cleanup below): a read that
    // started before a save can never land after the reconcile that follows it.
    fetchRoundShadowingResults(roundId)
      .then((server) => {
        if (cancelled || keyRef.current !== key) return;
        // One cache entry per (user, round), shared with the round reports.
        queryClient.setQueryData(shadowingRoundResultsKeys.round(userId, roundId), server);
        // A round pinned to another revision than the one displayed would
        // attach results to the wrong sentences — never merge it, and say
        // why the saved results aren't shown.
        if (server.transcriptId !== transcriptId) {
          if (server.segments.length > 0) {
            setServerLoadError("Your saved results belong to a different version of this script, so they aren't shown here.");
          }
          return;
        }
        setState((prev) => {
          if (prev.key !== key) return prev;
          const merged = mergeServerResults(prev.evaluations, server, (i) => referenceTextRef.current(i), {
            preserveLive: reconcile,
            // Unknown to this page's counter = restored from the cache, saved before this load.
            placedByThisRead: (attemptId) => (pendingSeqRef.current.get(attemptId) ?? 0) <= readSeq,
          });
          saveShadowingEvaluations(scope, merged);
          return { key, evaluations: merged };
        });
        setRefreshFailed(false);
      })
      .catch(() => {
        if (cancelled || keyRef.current !== key) return;
        // A failed reconcile keeps the confirmed selection and offers a
        // manual retry (reloadFromServer) — never an automatic refetch loop,
        // never a new evaluation.
        setRefreshFailed(true);
        if (!reconcile) setServerLoadError("Couldn't load your saved recordings. Showing what this tab still has.");
      });
    return () => {
      cancelled = true;
    };
    // `scope` is derived from exactly these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reloadToken]);

  const evaluations = useMemo<ShadowingEvaluationMap>(() => (state.key === key ? state.evaluations : {}), [state, key]);

  /**
   * A result of THIS scope was confirmed saved (direct write, polling or
   * recovery): re-read the round so the representative score follows the
   * server's order (R1), and mark the round report, Dashboard and History
   * stale (D7). Only for the scope the page shows — a late confirmation from
   * another account/round never touches this one's views.
   */
  const onConfirmedSave = useCallback(
    (origin: string, attemptId: string | undefined) => {
      if (!acceptsOrigin(origin, keyRef.current) || !userId || !roundId) return;
      saveSeqRef.current += 1;
      if (attemptId) pendingSeqRef.current.set(attemptId, saveSeqRef.current);
      invalidateLearningViews(queryClient, userId, { roundIds: [roundId] });
      setReloadToken((n) => n + 1);
    },
    [queryClient, userId, roundId]
  );

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
        if (completed.persistence === "unsaved" || completed.persistence === "superseded" || completed.persistence === "conflict") {
          return { ...(prev ?? emptyEntry(segmentIndex)), trueEvaluation: completed };
        }
        return withSavedEvaluation(prev, segmentIndex, completed);
      });
      if (data.persistence === "saved") onConfirmedSave(origin, data.attemptId);
    },
    [updateEntry, onConfirmedSave]
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
      // Even when the result is no longer on screen (a newer take replaced
      // it), the server now holds it: re-read so the representative score and
      // every report reflect it. Never for a superseded/conflicting save.
      if (persistence === "saved") onConfirmedSave(origin, attemptId);
    },
    [updateEntry, onConfirmedSave]
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

  const summary: ShadowingRoundSummary = useMemo(
    () => buildShadowingRoundSummary(summaryInputFromEvaluations(evaluations, { eligibleSentences, recordedSentences })),
    [evaluations, eligibleSentences, recordedSentences]
  );

  const hasPendingSelection = useMemo(
    () => Object.values(evaluations).some((e) => (e.selectionPending?.length ?? 0) > 0),
    [evaluations]
  );
  /** Saved but not yet placed by the server: "pending" while the re-read
   *  runs, "failed" when it failed (the summary keeps its confirmed data). */
  const summaryRefresh: "pending" | "failed" | null = hasPendingSelection ? (refreshFailed ? "failed" : "pending") : null;

  return {
    scopeKey: key,
    evaluations,
    summary,
    summaryRefresh,
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
