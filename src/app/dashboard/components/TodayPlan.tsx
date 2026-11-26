"use client";

import type { Ref } from "react";
import { ArrowDown, Circle, CircleCheck, Clock, SlidersHorizontal } from "lucide-react";
import type { TodayRow } from "@/lib/dashboard/today";
import type { DashboardWeek } from "@/lib/types/learning";
import { TodayTarget } from "./TodayTarget";

interface TodayPlanProps {
  /** The goal part; undefined while loading (`weekPending`) or unavailable. */
  week: DashboardWeek | undefined;
  weekPending: boolean;
  rows: TodayRow[];
  allDone: boolean;
  onChangeGoal: () => void;
  changeGoalRef: Ref<HTMLButtonElement>;
  /** Scroll to and focus the card that owns a task. */
  onJump: (target: "sentences" | "words") => void;
}

const TARGET_ID = { sentences: "continue-sentences", words: "review-deck" } as const;
const TARGET_NAME = { sentences: "go to the sentences", words: "go to the review deck" } as const;

/** An open task: the whole row jumps to the card where it's done. */
function JumpRow({ target, label, onJump }: { target: "sentences" | "words"; label: string; onJump: TodayPlanProps["onJump"] }) {
  return (
    <a
      href={`#${TARGET_ID[target]}`}
      data-testid={`today-row-${target}`}
      aria-label={`${label}, ${TARGET_NAME[target]}`}
      onClick={(e) => {
        e.preventDefault();
        onJump(target);
      }}
      className="group -mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-100 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
    >
      <Circle size={14} strokeWidth={2.5} aria-hidden="true" className="shrink-0 text-reward" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ArrowDown size={14} aria-hidden="true" className="shrink-0 text-slate-400 transition-colors group-hover:text-white" />
    </a>
  );
}

/**
 * The hero's Today list (plan §4.5.9): practice time toward the daily goal,
 * then whatever else is left today (sentences to look at again, words to
 * review), each jumping to the ONE card that owns the task, and "All done for
 * today ✓" once everything is clear. It replaces the old Next up card, which
 * repeated a card further down. Nothing it can't know is shown as zero or
 * as done.
 */
export function TodayPlan({ week, weekPending, rows, allDone, onChangeGoal, changeGoalRef, onJump }: TodayPlanProps) {
  if (!week && !weekPending && rows.length === 0) return null;
  return (
    <section data-testid="today-plan" aria-labelledby="today-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="today-heading" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-200">
          <Clock size={16} className="text-slate-300" aria-hidden="true" />
          Today
        </h2>
        {week && (
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
        )}
      </div>

      {week ? (
        <TodayTarget week={week} allDone={allDone} />
      ) : weekPending ? (
        <div aria-hidden="true" className="h-11 animate-pulse rounded-lg bg-white/[0.04]" />
      ) : null}

      {rows.length > 0 && (
        <ul aria-label="Today's tasks" className="space-y-0.5 border-t border-white/10 pt-2.5">
          {rows.map((row) =>
            row.kind === "sentences" ? (
              <li key="sentences">
                <JumpRow target="sentences" label={row.headline} onJump={onJump} />
              </li>
            ) : row.done ? (
              <li key="words" data-testid="today-row-words" data-done="true" className="flex items-center gap-2.5 py-1.5 text-sm text-slate-300">
                <CircleCheck size={14} strokeWidth={2.5} aria-hidden="true" className="shrink-0 text-success" />
                {row.reviewed} {row.reviewed === 1 ? "word" : "words"} reviewed today
              </li>
            ) : (
              <li key="words">
                <JumpRow target="words" label={row.headline} onJump={onJump} />
              </li>
            )
          )}
        </ul>
      )}
    </section>
  );
}
