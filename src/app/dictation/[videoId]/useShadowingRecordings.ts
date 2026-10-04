"use client";

import { useCallback, useRef, useState } from "react";
import { persistEvaluationRecovery, recordShadowingAttempt, ShadowingApiError, submitWordMatch } from "./shadowingApi";
import type { RecordShadowingAttemptResponse, WordMatchStatus } from "@/lib/practice/shadowingTypes";
import type { ResultPersistence } from "./types";

export type RecordingSaveStatus = "saving" | "saved" | "failed";

export interface RecordingSaveView {
  status: RecordingSaveStatus;
  error?: string;
  retryable?: boolean;
  attemptId?: string;
  isPracticeValid?: boolean;
}

interface RoundContext {
  epoch: number;
  roundId: string | null;
}

/** Everything about one finished take, captured ONCE when it finished — a
 *  later sentence/mode/round/account change never alters where it is saved. */
interface RecordingRecord {
  clipUrl: string;
  clientAttemptId: string;
  userId: string;
  videoId: string;
  transcriptId: string;
  segmentIndex: number;
  durationSec: number;
  roundCtx: RoundContext;
  /** Scope key of the evaluations map this take's results belong to. */
  origin: string;
  status: RecordingSaveStatus;
  error?: string;
  retryable?: boolean;
  attemptId?: string;
  isPracticeValid?: boolean;
  inFlight?: Promise<string | null>;
  wordMatch?: { status: WordMatchStatus; recognizedText?: string };
  wordMatchState?: "sending" | "saved" | "failed";
}

interface RecoveryEntry {
  token: string;
  origin: string;
  segmentIndex: number;
}

export interface ShadowingRecordingsDeps {
  getRoundContext: () => RoundContext;
  applyRoundUpdate: (
    ctx: RoundContext,
    r: Pick<RecordShadowingAttemptResponse, "roundId" | "roundStatus" | "progress" | "roundCompletedByThisRequest">
  ) => boolean;
  /** The server stored (or refused) the Word Match of `attemptId`. */
  onWordMatchPersisted: (origin: string, segmentIndex: number, take: { clipUrl: string; attemptId: string }, persisted: boolean) => void;
  onScorePersistence: (origin: string, segmentIndex: number, attemptId: string, persistence: ResultPersistence) => void;
  /** This page's round was completed by a Shadowing save from this page. */
  onRoundCompleted: () => void;
}

function newClientAttemptId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function messageFor(err: unknown): { error: string; retryable: boolean } {
  if (err instanceof ShadowingApiError) {
    if (err.status === 0) return { error: "Couldn't reach the server. Your recording is kept — retry saving.", retryable: true };
    if (err.code === "write_gate_paused") {
      return { error: "Saving is paused for maintenance. Your recording is kept — retry in a moment.", retryable: true };
    }
    if (err.status === 401) return { error: "Sign in again to save this recording.", retryable: false };
    return { error: err.message, retryable: err.retryable };
  }
  return { error: "Couldn't save this recording.", retryable: true };
}

/**
 * Phase 4: saves every finished Shadowing take as a practice attempt the
 * moment it finishes (independently of any evaluation), keeps its
 * in-memory clip usable for a retry while the page is open, forwards the
 * take's Word Match to the server once the attempt has an id, and holds
 * evaluation recovery tokens in memory only.
 */
export function useShadowingRecordings(deps: ShadowingRecordingsDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const recordsRef = useRef(new Map<string, RecordingRecord>());
  const recoveryRef = useRef(new Map<string, RecoveryEntry>());
  // Bumped whenever a record changes, so views re-render.
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const flushWordMatch = useCallback((rec: RecordingRecord) => {
    if (!rec.attemptId || !rec.wordMatch || rec.wordMatchState === "sending" || rec.wordMatchState === "saved") return;
    const attemptId = rec.attemptId;
    rec.wordMatchState = "sending";
    submitWordMatch(attemptId, rec.wordMatch)
      .then(() => {
        rec.wordMatchState = "saved";
        depsRef.current.onWordMatchPersisted(rec.origin, rec.segmentIndex, { clipUrl: rec.clipUrl, attemptId }, true);
      })
      .catch(() => {
        rec.wordMatchState = "failed";
        depsRef.current.onWordMatchPersisted(rec.origin, rec.segmentIndex, { clipUrl: rec.clipUrl, attemptId }, false);
      })
      .finally(bump);
  }, [bump]);

  const send = useCallback(
    (rec: RecordingRecord): Promise<string | null> => {
      rec.status = "saving";
      rec.error = undefined;
      bump();
      const p = recordShadowingAttempt({
        youtubeVideoId: rec.videoId,
        roundId: rec.roundCtx.roundId,
        transcriptId: rec.transcriptId,
        segmentIndex: rec.segmentIndex,
        clientAttemptId: rec.clientAttemptId, // same id on every retry of this take
        recordingDurationSec: rec.durationSec,
      })
        .then((r) => {
          rec.status = "saved";
          rec.attemptId = r.attemptId;
          rec.isPracticeValid = r.isPracticeValid;
          // Coverage/progress only from the server's answer, and only onto
          // the round this take belongs to.
          const applied = depsRef.current.applyRoundUpdate(rec.roundCtx, r);
          if (applied && r.roundCompletedByThisRequest) depsRef.current.onRoundCompleted();
          flushWordMatch(rec);
          return r.attemptId;
        })
        .catch((err: unknown) => {
          const m = messageFor(err);
          rec.status = "failed";
          rec.error = m.error;
          rec.retryable = m.retryable;
          return null;
        })
        .finally(() => {
          rec.inFlight = undefined;
          bump();
        });
      rec.inFlight = p;
      return p;
    },
    [bump, flushWordMatch]
  );

  /** A take just finished (never called for a cancelled/discarded one). */
  const saveRecording = useCallback(
    (params: {
      clipUrl: string;
      userId: string;
      videoId: string;
      transcriptId: string;
      segmentIndex: number;
      durationSec: number;
      origin: string;
    }) => {
      if (recordsRef.current.has(params.clipUrl)) return;
      const rec: RecordingRecord = {
        ...params,
        clientAttemptId: newClientAttemptId(), // one per logical recording
        roundCtx: depsRef.current.getRoundContext(),
        status: "saving",
      };
      recordsRef.current.set(params.clipUrl, rec);
      void send(rec);
    },
    [send]
  );

  const retrySave = useCallback(
    (clipUrl: string) => {
      const rec = recordsRef.current.get(clipUrl);
      if (!rec) return;
      if (rec.status === "saved") {
        flushWordMatch(rec);
        return;
      }
      if (!rec.inFlight) void send(rec);
    },
    [send, flushWordMatch]
  );

  /** Resolves with the take's attempt id once saved (waits for an in-flight
   *  save), or null when it isn't saved. */
  const ensureSaved = useCallback(async (clipUrl: string): Promise<string | null> => {
    const rec = recordsRef.current.get(clipUrl);
    if (!rec) return null;
    if (rec.attemptId) return rec.attemptId;
    if (rec.inFlight) return rec.inFlight;
    return null;
  }, []);

  const setWordMatchOutcome = useCallback(
    (clipUrl: string, outcome: { status: WordMatchStatus; recognizedText?: string }) => {
      const rec = recordsRef.current.get(clipUrl);
      if (!rec || rec.wordMatch) return;
      rec.wordMatch = outcome;
      flushWordMatch(rec);
    },
    [flushWordMatch]
  );

  const view = useCallback(
    (clipUrl: string | null | undefined): RecordingSaveView | null => {
      const rec = clipUrl ? recordsRef.current.get(clipUrl) : undefined;
      if (!rec) return null;
      return {
        status: rec.status,
        error: rec.error,
        retryable: rec.retryable,
        attemptId: rec.attemptId,
        isPracticeValid: rec.isPracticeValid,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  // ---- Evaluation recovery (memory only) ----
  const [recoveryErrors, setRecoveryErrors] = useState<Record<string, string>>({});

  const retryScoreSave = useCallback(
    async (attemptId: string) => {
      const entry = recoveryRef.current.get(attemptId);
      if (!entry) return;
      try {
        await persistEvaluationRecovery(entry.token);
        recoveryRef.current.delete(attemptId);
        setRecoveryErrors((e) => ({ ...e, [attemptId]: "" }));
        depsRef.current.onScorePersistence(entry.origin, entry.segmentIndex, attemptId, "saved");
      } catch (err) {
        const e = err instanceof ShadowingApiError ? err : null;
        if (e?.code === "recovery_superseded") {
          recoveryRef.current.delete(attemptId);
          depsRef.current.onScorePersistence(entry.origin, entry.segmentIndex, attemptId, "superseded");
        } else if (e && (e.status === 410 || e.status === 400 || e.status === 403 || e.status === 404)) {
          recoveryRef.current.delete(attemptId);
          setRecoveryErrors((m) => ({ ...m, [attemptId]: e.message }));
        } else {
          setRecoveryErrors((m) => ({ ...m, [attemptId]: "Still couldn't save the score. Try again in a moment." }));
        }
      } finally {
        bump();
      }
    },
    [bump]
  );

  const rememberRecovery = useCallback(
    (attemptId: string, token: string, origin: string, segmentIndex: number) => {
      recoveryRef.current.set(attemptId, { token, origin, segmentIndex });
      bump();
      // One automatic attempt shortly after; the user can retry after that.
      setTimeout(() => void retryScoreSave(attemptId), 1500);
    },
    [bump, retryScoreSave]
  );

  const canRetryScoreSave = useCallback(
    (attemptId: string | undefined) => !!attemptId && recoveryRef.current.has(attemptId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  /**
   * Takes and scores not yet stored (the new-round confirmation shows them;
   * a new round never drops them silently). Each still saves into the round
   * it was made in.
   */
  const pendingWork = useCallback(
    () => {
      let saving = 0;
      let failed = 0;
      for (const rec of recordsRef.current.values()) {
        if (rec.status === "saving") saving += 1;
        else if (rec.status === "failed") failed += 1;
      }
      return { saving, failed, scoresUnsaved: recoveryRef.current.size };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  /** Retry every failed take save and every unsaved score (same ids, same rounds). */
  const retryUnsaved = useCallback(() => {
    for (const rec of recordsRef.current.values()) {
      if (rec.status === "failed" && !rec.inFlight) void send(rec);
    }
    for (const attemptId of recoveryRef.current.keys()) void retryScoreSave(attemptId);
  }, [send, retryScoreSave]);

  /** The learner explicitly chose to give up the unsaved takes and scores. */
  const discardUnsaved = useCallback(() => {
    for (const [clipUrl, rec] of recordsRef.current) {
      if (rec.status === "failed") recordsRef.current.delete(clipUrl);
    }
    recoveryRef.current = new Map();
    setRecoveryErrors({});
    bump();
  }, [bump]);

  /** Forget everything (sign-out / account switch). In-flight saves still
   *  complete server-side but can no longer touch this page. */
  const reset = useCallback(() => {
    recordsRef.current = new Map();
    recoveryRef.current = new Map();
    setRecoveryErrors({});
    bump();
  }, [bump]);

  return {
    saveRecording,
    retrySave,
    ensureSaved,
    setWordMatchOutcome,
    view,
    rememberRecovery,
    retryScoreSave,
    canRetryScoreSave,
    recoveryErrors,
    pendingWork,
    retryUnsaved,
    discardUnsaved,
    reset,
  };
}
