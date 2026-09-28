"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ShadowingAttemptDto } from "@/lib/practice/shadowingTypes";
import { acceptsOrigin } from "./shadowingEvaluationPersistence";
import { waitForStoredEvaluation, type StoredEvaluationWait } from "./shadowingApi";

export interface EvaluationWaitTarget {
  attemptId: string;
  /** The take (object URL) the wait belongs to. */
  clipId: string;
  /** Scope key (user, video, revision, round) the evaluation was started in. */
  origin: string;
}

interface WaitOperation extends EvaluationWaitTarget {
  controller: AbortController;
}

/**
 * Per-operation cancellation for "this recording is already being
 * evaluated" waits. Each wait owns its AbortController; cancelling one never
 * touches another attempt's wait. The unmount cleanup aborts every wait
 * created so far — permanently, since an aborted controller cannot resume —
 * so a Strict Mode cleanup/setup cycle never revives an old wait, and waits
 * started after the new setup work normally.
 */
export function useEvaluationWaits(options: { intervalMs?: number; maxWaitMs?: number } = {}) {
  const opsRef = useRef(new Set<WaitOperation>());
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const ops = opsRef.current;
    return () => {
      for (const op of ops) op.controller.abort();
      ops.clear();
    };
  }, []);

  const cancelWhere = useCallback((predicate: (target: EvaluationWaitTarget) => boolean) => {
    for (const op of opsRef.current) {
      if (predicate(op)) {
        op.controller.abort();
        opsRef.current.delete(op);
      }
    }
  }, []);

  const cancelAll = useCallback(() => cancelWhere(() => true), [cancelWhere]);

  /** Cancels waits whose results could no longer be shown under `currentKey`. */
  const cancelOutsideScope = useCallback(
    (currentKey: string) => cancelWhere((op) => !acceptsOrigin(op.origin, currentKey)),
    [cancelWhere]
  );

  const wait = useCallback(
    async (target: EvaluationWaitTarget): Promise<StoredEvaluationWait> => {
      // A newer wait for the same attempt replaces the older one.
      cancelWhere((op) => op.attemptId === target.attemptId);
      const op: WaitOperation = { ...target, controller: new AbortController() };
      opsRef.current.add(op);
      try {
        const result = await waitForStoredEvaluation(target.attemptId, {
          signal: op.controller.signal,
          intervalMs: optionsRef.current.intervalMs,
          maxWaitMs: optionsRef.current.maxWaitMs,
        });
        // Cancelled while the last read was resolving — report it as such.
        return op.controller.signal.aborted ? { kind: "cancelled" } : result;
      } finally {
        opsRef.current.delete(op);
      }
    },
    [cancelWhere]
  );

  return useMemo(() => ({ wait, cancelWhere, cancelAll, cancelOutsideScope }), [wait, cancelWhere, cancelAll, cancelOutsideScope]);
}

export interface StoredEvaluationHandlers {
  complete: (attempt: ShadowingAttemptDto) => void;
  fail: (message: string) => void;
  /** Called once a visible update was made (e.g. to flag an unread result). */
  updated: () => void;
}

/**
 * Applies a finished wait to the page. `cancelled` changes nothing — no
 * status, message or unread flag. A settled answer for another attempt is
 * ignored (defence in depth; the evaluation map also re-checks the scope).
 */
export function applyStoredEvaluationWait(
  result: StoredEvaluationWait,
  attemptId: string,
  handlers: StoredEvaluationHandlers
): "ignored" | "completed" | "failed" | "gave_up" {
  if (result.kind === "cancelled") return "ignored";
  if (result.kind === "gave_up") {
    handlers.fail(
      result.reason === "deadline"
        ? "This recording is still being evaluated. Check back in a moment."
        : "Couldn't check this recording's evaluation. Check back in a moment."
    );
    handlers.updated();
    return "gave_up";
  }
  const { attempt } = result;
  if (attempt.attemptId !== attemptId) return "ignored";
  if (attempt.azure.status === "completed") {
    handlers.complete(attempt);
    handlers.updated();
    return "completed";
  }
  handlers.fail(
    attempt.azure.errorReason === "expired"
      ? "The earlier evaluation of this recording didn't finish. Press Retry to evaluate it again."
      : (attempt.azure.errorReason ?? "The evaluation failed. Press Retry to try again.")
  );
  handlers.updated();
  return "failed";
}
