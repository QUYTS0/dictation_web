"use client";

import { useCallback, useState } from "react";
import { newRoundConfirmation, type PendingLocalWork, type RoundStatus } from "@/lib/practice/roundMenu";
import type { RestartOutcome } from "./useDictationSession";

export type NewRoundFlowResult =
  | { kind: "failed"; message: string }
  | { kind: "already_active"; roundNumber: number | null };

/**
 * The ONE "new round" flow of the practice page (Learning Reports P2
 * follow-up): the Round menu, the completed-round card, the resume card and
 * the report actions all open this same confirmation, and only its confirm
 * button sends the restart request — once, never retried automatically.
 *
 *  - Opening or cancelling sends nothing and changes nothing.
 *  - Running recordings and saves still in flight block the request (they
 *    clear by themselves); unsaved takes/scores need "Retry saving" or an
 *    explicit discard, applied only after the server confirmed the new round.
 *  - Local practice state changes only after the server confirmed.
 */
export function useNewRoundFlow(opts: {
  status: RoundStatus | null;
  newerActiveRound: { roundId: string; roundNumber: number } | null;
  pendingWork: PendingLocalWork;
  restart: () => Promise<RestartOutcome>;
  restartPending: boolean;
  /** The learner chose to give up unsaved takes/scores (after success only). */
  discardUnsaved: () => void;
  /** Page-local reset after the server confirmed the new round. */
  onStarted: () => void;
}) {
  const { status, newerActiveRound, pendingWork, restart, restartPending, discardUnsaved, onStarted } = opts;
  const [open, setOpen] = useState(false);
  const [discardAcknowledged, setDiscardAcknowledged] = useState(false);
  const [result, setResult] = useState<NewRoundFlowResult | null>(null);

  const confirmation = newRoundConfirmation(status, pendingWork);
  const needsDiscardChoice = confirmation.unsaved !== null && !discardAcknowledged;
  const canConfirm = !newerActiveRound && !restartPending && confirmation.blockers.length === 0 && !needsDiscardChoice;

  const request = useCallback(() => {
    setDiscardAcknowledged(false);
    setResult(null);
    setOpen(true);
  }, []);

  const cancel = useCallback(() => {
    if (restartPending) return; // the request is already on its way
    setOpen(false);
    setResult(null);
  }, [restartPending]);

  const confirm = useCallback(async () => {
    if (!canConfirm) return;
    const discard = confirmation.unsaved !== null && discardAcknowledged;
    setResult(null);
    const outcome = await restart();
    if (outcome.kind === "started") {
      if (discard) discardUnsaved();
      onStarted();
      setOpen(false);
    } else if (outcome.kind === "failed") {
      setResult({ kind: "failed", message: outcome.message });
    } else if (outcome.kind === "already_active") {
      setResult({ kind: "already_active", roundNumber: outcome.roundNumber });
    }
  }, [canConfirm, confirmation.unsaved, discardAcknowledged, restart, discardUnsaved, onStarted]);

  return {
    open,
    request,
    cancel,
    confirm,
    confirmation,
    canConfirm,
    pending: restartPending,
    discardAcknowledged,
    setDiscardAcknowledged,
    result,
  };
}

export type NewRoundFlow = ReturnType<typeof useNewRoundFlow>;
