"use client";

import { useEffect, useRef } from "react";
import { clsx } from "clsx";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Disables both buttons and swaps the confirm label to a busy state
   *  while the caller's own delete mutation is in flight. */
  isConfirming?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Generic confirm dialog — a single shared instance is rendered by
 * page.tsx for both the single-item (drawer) and bulk delete flows (see the
 * Vocabulary UX redesign plan §I), never two at once. Always a true modal
 * regardless of what triggered it (own backdrop, Tab-trap, Escape,
 * focus-restore-on-unmount), modeled on AuthModal.tsx's manual dialog
 * pattern. `z-[90]` sits above the Vocabulary detail drawer (`z-[75]`) and
 * its own mobile backdrop (`z-[70]`), so it is always the topmost layer —
 * the drawer additionally suspends its own Escape/Tab handling while this
 * is open (its `modalSuspended` prop) so the two don't fight over the same
 * keystroke.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = true,
  isConfirming = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    // Focus the Cancel button by default, not Confirm — the safer default
    // for a destructive action reachable by an immediate Enter/Space press.
    cancelButtonRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
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
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      data-testid="confirm-dialog-backdrop"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
        className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-white p-6 shadow-xl"
      >
        <div>
          <h2 id="confirm-dialog-title" className="text-lg font-bold text-slate-800">
            {title}
          </h2>
          <p id="confirm-dialog-body" className="mt-2 text-sm text-slate-500">
            {body}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            disabled={isConfirming}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isConfirming}
            className={clsx(
              "rounded-xl px-4 py-2 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              destructive ? "bg-red-600 hover:bg-red-700" : "bg-primary-600 hover:bg-primary-700"
            )}
          >
            {isConfirming ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
