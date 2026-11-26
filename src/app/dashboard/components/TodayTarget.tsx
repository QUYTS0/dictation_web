"use client";

import type { DashboardWeek } from "@/lib/types/learning";
import { goalProgress } from "@/lib/dashboard/week";

/**
 * Today's target (plan §1, D3), the first item of the hero's Today list:
 * today's active minutes against the daily goal, teal with "Goal met today ✓"
 * once reached ("All done for today ✓" when nothing else is left either).
 * The goal is a preference (Profile & preferences); it earns nothing and
 * changes no metric. Word reviews keep the streak but carry no time, so they
 * don't move this bar.
 */
export function TodayTarget({ week, allDone = false }: { week: DashboardWeek; allDone?: boolean }) {
  const { minutes, goalMinutes, pct, met } = goalProgress(week);
  return (
    <div data-testid="today-target" data-met={met} className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-200">Practice time</span>
        <span data-testid="today-target-value" className={`font-mono font-bold ${met ? "text-success" : "text-reward"}`}>
          <span aria-hidden="true">
            {minutes} / {goalMinutes} min
          </span>
          <span className="sr-only">
            {minutes} of {goalMinutes} minutes
          </span>
        </span>
      </div>
      <div aria-hidden="true" className="h-2.5 w-full overflow-hidden rounded-full border border-white/10 bg-black/25 p-0.5">
        <div className={`animate-progress-fill h-full rounded-full ${met ? "bg-success" : "bg-primary-600"}`} style={{ width: `${pct}%` }} />
      </div>
      {met && (
        <p data-testid={allDone ? "today-all-done" : undefined} className="text-xs font-semibold text-success">
          {allDone ? "All done for today ✓" : "Goal met today ✓"}
        </p>
      )}
    </div>
  );
}
