"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

interface ModalDialogProps {
  /** Id of the element that names the dialog (its heading). */
  labelledBy: string;
  onClose: () => void;
  /** Focused on open; else the first focusable element in the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Focused on close; else whatever had focus when the dialog opened. Use
   *  it when the opener itself unmounts (a menu item). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  backdropTestId?: string;
  panelClassName?: string;
  children: ReactNode;
}

/**
 * A true modal: own backdrop (click outside closes), Tab trapped inside,
 * Escape closes, focus restored on unmount. Portaled to <body>: the sticky
 * header uses backdrop-filter, which would otherwise become the containing
 * block of this fixed overlay.
 */
export function ModalDialog({
  labelledBy,
  onClose,
  initialFocusRef,
  returnFocusRef,
  backdropTestId,
  panelClassName,
  children,
}: ModalDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const back = returnFocusRef?.current ?? (document.activeElement as HTMLElement | null);
    const target = initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    target?.focus();
    return () => back?.focus?.();
  }, [initialFocusRef, returnFocusRef]);

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

  return createPortal(
    <div
      data-testid={backdropTestId}
      // overflow-y-auto: a dialog taller than a short phone screen scrolls
      // instead of hiding its buttons below the fold.
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto overscroll-contain bg-hero/60 p-4 pt-[10vh] backdrop-blur-sm sm:pt-[15vh]"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={clsx("w-full rounded-3xl border border-line bg-white p-6 shadow-2xl", panelClassName ?? "max-w-xl")}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
