"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Shared page-level dialog chrome for the Evaluate tab's two full-viewport
 * reports (per-sentence Detailed report, video-wide Video summary) —
 * extracted so the portal/focus-trap/backdrop-opacity logic exists in
 * exactly one place. See PronunciationReportModal.tsx's original doc
 * comment (preserved in spirit here) for why this must be a portal at all:
 *
 * Rendered via a React portal directly into `document.body` — NOT as a
 * normal in-place child. This is used from deep inside the right panel,
 * which page.tsx animates with Framer Motion's `x` motion value (see the
 * `motion.div ref={rightPanelRef}` wrapper around RightPanelTabs). Framer
 * Motion keeps that transform applied via inline style even at rest
 * (`translateX(0px)`), and any non-none `transform` on an ancestor becomes
 * the containing block for every `position: fixed` descendant — so without
 * the portal, this modal's `inset`/centering resolves against that narrow
 * right-panel box instead of the viewport, and gets visually confined to
 * (and clipped by) the sidebar. Portaling to `document.body` sidesteps that
 * ancestor entirely, matching the app's SettingsDrawer/MobileBottomSheet
 * dialog z-index layer (backdrop z-[70], panel z-[75]) but escaping every
 * stacking/containing-block context inside the practice page.
 *
 * Desktop: a centered card (see PANEL_SIZE_CLASS). Mobile: a true
 * full-screen sheet (100dvh, safe-area aware). The header is a non-scrolling
 * flex sibling above the scrollable content (rather than `position:
 * sticky`), so the close button can never be scrolled away.
 */
// Deliberately no backdrop-blur (or any other filter/opacity) on the dialog
// surface itself — it must stay 100% opaque. A `backdrop-filter` there
// previously let the YouTube iframe behind it bleed through despite the
// solid --surface background: iframes get their own compositing layer, and
// Chromium doesn't reliably composite backdrop-filter over that layer the
// way it does over ordinary painted content, even when the element's own
// background-color has alpha=1. The (intentionally translucent) dimming
// lives on the Backdrop layer below instead.
const PANEL_SIZE_CLASS =
  "fixed inset-0 z-[75] flex flex-col overflow-hidden bg-[var(--surface)] text-[var(--text)] sm:inset-0 sm:m-auto sm:h-[min(85vh,850px)] sm:w-[min(900px,calc(100vw-64px))] sm:max-w-[1000px] sm:rounded-3xl sm:border sm:border-[var(--border)] sm:shadow-2xl";

export function ReportDialogShell({
  open,
  onClose,
  titleId,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  titleId: string;
  title: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // The portal target (document.body) only exists client-side — this flips
  // true on the first client render so the initial server-rendered markup
  // never tries to portal (avoids a hydration mismatch).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // The whole point of this modal is a page-level overlay — the underlying
  // practice page (video, script, control bar) must not scroll behind it.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
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
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    // The `player-dark-theme` class carries the --surface/--text/--border/etc.
    // custom properties this component's Tailwind arbitrary-value classes
    // depend on — it's normally provided by an ancestor further up the
    // practice page (see player-theme.css). Portaling to document.body moves
    // this subtree outside that ancestor, so those variables would otherwise
    // be undefined and every background using one of these tokens would
    // resolve to its CSS initial value (transparent). Re-declaring the class
    // here gives the portalled subtree its own copy of the same tokens,
    // independent of where in the DOM it landed.
    <div className="player-dark-theme">
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm"
              onClick={onClose}
            />
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ type: "tween", ease: "easeOut", duration: 0.2 }}
              className={PANEL_SIZE_CLASS}
            >
              <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))] sm:pt-5">
                <h2 id={titleId} className="text-sm font-semibold text-[var(--text)]">
                  {title}
                </h2>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-white/10"
                  aria-label={`Close ${title.toLowerCase()}`}
                >
                  <X size={16} />
                </button>
              </div>

              <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {children}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>,
    document.body
  );
}
