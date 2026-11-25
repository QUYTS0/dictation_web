"use client";

import type { Ref } from "react";
import { Clock, SlidersHorizontal } from "lucide-react";
import type { DashboardWeek } from "@/lib/types/learning";
import { goalProgress } from "@/lib/dashboard/week";

interface TodayTargetProps {
  week: DashboardWeek;
  onChangeGoal: () => void;
  changeGoalRef: Ref<HTMLButtonElement>;
}

/**
 * Today's target (plan §1, D3): today's active minutes against the daily
 * goal — teal with "Goal met today ✓" once reached. The goal is a
 * preference (Profile & preferences); it earns nothing and changes no metric.
 * Word reviews keep the streak but carry no time, so they don't move this bar.
 */
export function TodayTarget({ week, onChangeGoal, changeGoalRef }: TodayTargetProps) {
  const { minutes, goalMinutes, pct, met } = goalProgress(week);
  return (
    <div data-testid="today-target" data-met={met} className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-200">
          <Clock size={16} className="text-slate-300" aria-hidden="true" />
          Today&apos;s target
        </h2>
        <div className="flex items-center gap-1">
          <span data-testid="today-target-value" className={`font-mono text-xs font-bold ${met ? "text-success" : "text-reward"}`}>
            <span aria-hidden="true">
              {minutes} / {goalMinutes} min
            </span>
            <span className="sr-only">
              {minutes} of {goalMinutes} minutes
            </span>
          </span>
          <button
            ref={changeGoalRef}
            type="button"
            onClick={onChangeGoal}
            aria-label="Change daily goal"
            title="Change daily goal"
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div aria-hidden="true" className="h-2.5 w-full overflow-hidden rounded-full border border-white/10 bg-black/25 p-0.5">
        <div className={`h-full rounded-full transition-[width] duration-700 ${met ? "bg-success" : "bg-primary-600"}`} style={{ width: `${pct}%` }} />
      </div>
      {met && <p className="text-xs font-semibold text-success">Goal met today ✓</p>}
    </div>
  );
}
