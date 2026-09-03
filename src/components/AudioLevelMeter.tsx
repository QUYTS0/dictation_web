"use client";

import { clsx } from "clsx";

const BAR_COUNT = 12;
// Bars past this fraction turn red — a rough "you're probably clipping/too
// loud" cue, not a calibrated loudness measurement.
const HOT_FRACTION = 0.75;

/** Simple VU-meter-style bar row driven by useAudioRecorder's 0..1 `level`. */
export function AudioLevelMeter({ level, active }: { level: number; active: boolean }) {
  const litBars = active ? Math.round(Math.min(1, Math.max(0, level)) * BAR_COUNT) : 0;

  return (
    <div
      className="flex items-end gap-0.5"
      role="img"
      aria-label={active ? `Microphone level ${Math.round(level * 100)}%` : "Microphone idle"}
    >
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          className={clsx(
            "w-1 rounded-full transition-colors duration-75",
            i < litBars ? (i < BAR_COUNT * HOT_FRACTION ? "bg-[var(--green)]" : "bg-[var(--red)]") : "bg-[var(--border-strong)]"
          )}
          style={{ height: `${8 + (i / BAR_COUNT) * 16}px` }}
        />
      ))}
    </div>
  );
}
