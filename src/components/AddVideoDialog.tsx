"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { AddVideoForm } from "@/components/AddVideoForm";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

interface AddVideoDialogProps {
  url: string;
  onUrlChange: (url: string) => void;
  onClose: () => void;
}

/**
 * The header's "New video" dialog, reachable from every signed-in page. A
 * true modal (own backdrop, Tab trap, Escape, focus restored to whatever
 * opened it on unmount), following ConfirmDialog's pattern. The typed link
 * is owned by the caller, so closing and reopening keeps it.
 */
export function AddVideoDialog({ url, onUrlChange, onClose }: AddVideoDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
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
  }, [onClose]);

  // Portaled to <body>: the sticky header that opens it uses backdrop-filter,
  // which would otherwise become the containing block of this fixed overlay.
  return createPortal(
    <div
      data-testid="add-video-dialog-backdrop"
      className="fixed inset-0 z-[80] flex items-start justify-center bg-hero/60 p-4 pt-[15vh] backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-video-dialog-title"
        className="w-full max-w-xl rounded-3xl border border-line bg-white p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="add-video-dialog-title" className="text-lg font-bold text-ink">
              New video
            </h2>
            <p className="mt-0.5 text-sm text-muted">Paste a YouTube link to start practicing it.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close new video"
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>
        <AddVideoForm url={url} onUrlChange={onUrlChange} inputRef={inputRef} />
      </div>
    </div>,
    document.body
  );
}
