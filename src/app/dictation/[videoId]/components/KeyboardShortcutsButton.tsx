"use client";

import { useEffect, useRef, useState } from "react";
import { Keyboard } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { DICTATION_SHORTCUTS } from "../constants";

/**
 * Small header button that pops open a lightweight list of the shortcuts
 * relevant to actively practicing the current sentence — a quick reference
 * that doesn't require opening the full Settings drawer. The complete list
 * (including general, non-dictation shortcuts) still lives there.
 */
export function KeyboardShortcutsButton() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative hidden sm:block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] transition-colors hover:bg-white/10"
        title="Keyboard shortcuts"
        aria-label="Show keyboard shortcuts"
        aria-expanded={open}
      >
        <Keyboard size={15} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.12 }}
            role="dialog"
            aria-label="Dictation keyboard shortcuts"
            className="absolute right-0 top-full z-50 mt-2 w-[300px] max-w-[calc(100vw-2rem)] rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] p-4 shadow-2xl"
          >
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">
              Dictation shortcuts
            </p>
            <div className="flex flex-col gap-1.5">
              {DICTATION_SHORTCUTS.map((shortcut) => (
                <div key={shortcut.keys + shortcut.label} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-[var(--text-muted)]">{shortcut.label}</span>
                  <kbd className="shrink-0 rounded border border-[var(--border-strong)] bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--text-muted)]">
                    {shortcut.keys}
                  </kbd>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-[var(--text-faint)]">See Settings for the full shortcut list.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
