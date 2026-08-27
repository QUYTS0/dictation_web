"use client";

import { clsx } from "clsx";
import type { SubtitleVisibility, SubtitleVisibilityState } from "../types";

const OPTIONS: { value: SubtitleVisibility; label: string }[] = [
  { value: "show", label: "Show" },
  { value: "blur", label: "Blur" },
  { value: "hide", label: "Hide" },
];

function VisibilityRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: SubtitleVisibility;
  onChange: (value: SubtitleVisibility) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">{label}</p>
      <div className="flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] p-1">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className={clsx(
              "flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
              value === option.value ? "bg-[var(--accent)] text-[#1a1206]" : "text-[var(--text-muted)] hover:bg-white/10"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Small popup controlling subtitle Show/Blur/Hide for the original text and its translation independently. */
export function SubtitleVisibilityPopup({
  subtitleVisibility,
  setOriginalVisibility,
  setTranslationVisibility,
}: {
  subtitleVisibility: SubtitleVisibilityState;
  setOriginalVisibility: (value: SubtitleVisibility) => void;
  setTranslationVisibility: (value: SubtitleVisibility) => void;
}) {
  return (
    <div className="flex w-[280px] flex-col gap-4 rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] p-4 shadow-2xl">
      <VisibilityRow label="Original" value={subtitleVisibility.original} onChange={setOriginalVisibility} />
      <VisibilityRow label="Translation" value={subtitleVisibility.translation} onChange={setTranslationVisibility} />
    </div>
  );
}
