"use client";

import { useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import { Flame } from "lucide-react";

const dayLabel = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * The header's streak pill: consecutive local days with practice in any
 * mode. Opens a short explanation on hover, focus-click or tap; Escape or a
 * click outside closes it.
 */
export function StreakPill({ streakDays }: { streakDays: number }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const active = streakDays > 0;

  return (
    <div ref={containerRef} className="relative shrink-0" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        data-testid="header-streak"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={`Daily streak: ${dayLabel(streakDays)}`}
        className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1.5 text-ink transition-colors hover:border-primary-500/40 sm:px-3"
      >
        <Flame size={16} aria-hidden="true" className={clsx(active ? "animate-flame-subtle fill-reward/30 text-reward" : "text-muted")} />
        <span className="text-xs font-bold tabular-nums">{dayLabel(streakDays)}</span>
      </button>
      {open && (
        // pt-2 (not mt-2) keeps the gap inside the hover area, so moving the
        // pointer from the pill onto the panel doesn't close it.
        <div id={popoverId} className="absolute right-0 top-full z-50 w-64 pt-2">
          <div className="rounded-xl border border-hero-2 bg-hero p-3 text-xs text-white shadow-xl">
            <p className="mb-1.5 flex items-center gap-1 font-semibold text-reward">
              <Flame size={14} aria-hidden="true" /> {streakDays}-day streak
            </p>
            <p className="text-[11px] leading-relaxed text-slate-300">
              {active
                ? "Days in a row with practice in any mode. Practice every day to keep it going."
                : "Practice in any mode today to start a streak."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
