"use client";

import { useEffect, useRef } from "react";
import type { NewRoundFlow } from "../useNewRoundFlow";

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * The confirmation of the practice page's one "new round" flow (see
 * useNewRoundFlow). A true modal (backdrop, Tab trap, Escape = Cancel, focus
 * returns to whatever opened it), modelled on the shared ConfirmDialog but
 * with room for what a new round would leave behind. Cancel is the default
 * focus; while the request is in flight both buttons are disabled.
 */
export function NewRoundDialog({
  flow,
  newerActiveRound,
  currentRoundHref,
  onRetryUnsaved,
}: {
  flow: NewRoundFlow;
  newerActiveRound: { roundId: string; roundNumber: number } | null;
  currentRoundHref: string;
  onRetryUnsaved: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { cancel, confirmation, result } = flow;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cancel]);

  const alreadyActive = result?.kind === "already_active" ? result : null;
  const newer = alreadyActive
    ? { roundNumber: alreadyActive.roundNumber }
    : newerActiveRound
      ? { roundNumber: newerActiveRound.roundNumber }
      : null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => e.target === e.currentTarget && cancel()}
      data-testid="new-round-backdrop"
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="new-round-title"
        aria-describedby="new-round-body"
        data-testid="new-round-dialog"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] p-5 text-[var(--text)] shadow-2xl"
      >
        {newer ? (
          <div>
            <h2 id="new-round-title" className="text-base font-semibold">
              A newer round is already in progress
            </h2>
            <p id="new-round-body" className="mt-2 text-sm text-[var(--text-muted)]">
              {newer.roundNumber ? `Round ${newer.roundNumber}` : "Another round"} of this video is in progress, so no new
              round was started and nothing was changed. Continue that round instead.
            </p>
          </div>
        ) : (
          <div>
            <h2 id="new-round-title" className="text-base font-semibold">
              {confirmation.title}
            </h2>
            <p id="new-round-body" className="mt-2 text-sm text-[var(--text-muted)]">
              {confirmation.body}
            </p>
          </div>
        )}

        {!newer && confirmation.blockers.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-xl bg-[var(--surface-2)] px-3 py-2 text-xs" data-testid="new-round-blockers">
            {confirmation.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}

        {!newer && confirmation.unsaved && (
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--red)]/40 bg-[var(--red)]/10 px-3 py-2 text-xs" data-testid="new-round-unsaved">
            <p>{confirmation.unsaved} They would be lost if you start a new round.</p>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={onRetryUnsaved} disabled={flow.pending} className="font-semibold underline disabled:opacity-50">
                Retry saving
              </button>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={flow.discardAcknowledged}
                  disabled={flow.pending}
                  onChange={(e) => flow.setDiscardAcknowledged(e.target.checked)}
                />
                Discard them and continue
              </label>
            </div>
          </div>
        )}

        {!newer && confirmation.notes.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs text-[var(--text-muted)]" data-testid="new-round-notes">
            {confirmation.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        {result?.kind === "failed" && (
          <p role="alert" className="text-xs text-[var(--red)]">
            {result.message} Your current round is unchanged.
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancel}
            disabled={flow.pending}
            className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {newer ? "Close" : "Cancel"}
          </button>
          {newer ? (
            <a href={currentRoundHref} className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#1a1206]">
              Go to current round
            </a>
          ) : (
            <button
              type="button"
              onClick={() => void flow.confirm()}
              disabled={!flow.canConfirm}
              className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#1a1206] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {flow.pending ? "Starting…" : "Start new round"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
