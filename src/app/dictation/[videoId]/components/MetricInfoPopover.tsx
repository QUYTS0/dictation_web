"use client";

import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";

const METRIC_EXPLANATIONS: Array<{ label: string; body: string }> = [
  { label: "Pronunciation score", body: "Azure's overall score for this sentence — a blend of the four categories below." },
  { label: "Accuracy", body: "How closely each sound you said matched the correct pronunciation." },
  { label: "Fluency", body: "How smooth and natural your pacing was — few pauses, hesitations, or restarts." },
  { label: "Completeness", body: "How much of the sentence you actually said out loud, start to finish." },
  { label: "Prosody", body: "How natural your rhythm, stress, and intonation sounded compared to a native speaker." },
];

/** A small, click-to-toggle info popover explaining the five Pronunciation
 *  Assessment metrics in plain, learner-friendly language (not Azure API
 *  docs). Deliberately not rendered permanently under every metric — the
 *  right panel is narrow, so this stays a single icon that opens on demand
 *  and closes on outside click/Escape, matching the popover pattern already
 *  used by the control bar's speed/visibility/mode popovers. */
export function MetricInfoPopover() {
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
        aria-label="What do these scores mean?"
        className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-faint)] transition-colors hover:bg-white/10 hover:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Info size={13} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Score explanations"
          className="absolute right-0 top-full z-50 mt-1.5 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] p-3 text-xs shadow-2xl"
        >
          <div className="flex flex-col gap-2">
            {METRIC_EXPLANATIONS.map((item) => (
              <div key={item.label}>
                <p className="font-semibold text-[var(--text)]">{item.label}</p>
                <p className="text-[var(--text-muted)]">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
