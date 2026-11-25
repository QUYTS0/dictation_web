"use client";

import { useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import { Flame } from "lucide-react";
import { nextStreakMilestone } from "@/lib/achievements/catalog";
import { goalProgress } from "@/lib/dashboard/week";
import { useAchievementsQuery } from "@/lib/queries/achievements";
import { useDashboardWeekQuery } from "@/lib/queries/dashboard";

const dayLabel = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * The header's streak pill: consecutive local days with practice in any
 * mode. Opens a short explanation on hover, focus-click or tap; Escape or a
 * click outside closes it. The popover adds today's goal status and the
 * next streak milestone (the Flame Keeper thresholds, migration 049) —
 * loaded only once it's opened, and left out while unavailable.
 */
export function StreakPill({ streakDays, userId }: { streakDays: number; userId?: string }) {
  const [open, setOpen] = useState(false);
  // Fetched while open; a closed (disabled) query keeps its cached data.
  const week = useDashboardWeekQuery(userId, open).data;
  const flame = useAchievementsQuery(userId, open).data?.tracks.find((t) => t.track === "flame_keeper");
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
  const goal = week ? goalProgress(week) : null;
  const milestone = flame ? nextStreakMilestone(streakDays, flame) : undefined;

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
            {(goal || milestone !== undefined) && (
              <dl className="mt-2.5 space-y-1 border-t border-white/10 pt-2.5 text-[11px]">
                {goal && (
                  <div data-testid="streak-goal" className="flex justify-between gap-2">
                    <dt className="text-slate-400">Today&apos;s goal</dt>
                    <dd className={clsx("font-mono font-semibold", goal.met ? "text-success" : "text-slate-200")}>
                      {goal.met ? "Met ✓" : `${goal.minutes} / ${goal.goalMinutes} min`}
                    </dd>
                  </div>
                )}
                {milestone !== undefined && (
                  <div data-testid="streak-milestone" className="flex justify-between gap-2">
                    <dt className="text-slate-400">Next milestone</dt>
                    <dd className="font-mono font-semibold text-slate-200">
                      {milestone ? `${milestone.days} days · ${milestone.toGo} to go` : "All passed ✓"}
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
