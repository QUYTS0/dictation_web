"use client";

import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";

/**
 * Explains why Word Match can disagree with the Pronunciation Assessment
 * below it — e.g. a word showing "Missing" here while Azure still scored
 * its pronunciation. This is not a bug: Word Match runs the browser's own
 * built-in SpeechRecognition API (see hooks/useSpeechRecognition.ts), a
 * separate, generally less accurate speech-to-text engine than the one
 * behind Azure's Pronunciation Assessment — the two can genuinely disagree
 * about what was said. Mirrors MetricInfoPopover's click-toggle/outside-
 * click/Escape pattern so the two info affordances behave identically.
 */
export function WordMatchInfoPopover() {
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
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Why can Word Match disagree with the Pronunciation score?"
        className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-faint)] transition-colors hover:bg-white/10 hover:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Info size={13} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="About Word Match"
          className="absolute left-0 top-full z-50 mt-1.5 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] p-3 text-xs shadow-2xl"
        >
          <p className="text-[var(--text-muted)]">
            Word Match uses your browser&apos;s own speech recognition — a separate, generally less accurate engine
            than the Azure Pronunciation Assessment below. A word can show as Missing here even when Azure still
            scored its pronunciation; the two don&apos;t always agree on what was said.
          </p>
        </div>
      )}
    </div>
  );
}
