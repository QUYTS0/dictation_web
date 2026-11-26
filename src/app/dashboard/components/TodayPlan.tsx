"use client";

import type { Ref } from "react";
import clsx from "clsx";
import { ArrowDown, Circle, CircleCheck, Clock, Plus, SlidersHorizontal } from "lucide-react";
import { isOpenRow, type TodayRow } from "@/lib/dashboard/today";
import type { DashboardWeek } from "@/lib/types/learning";
import { TodayTarget } from "./TodayTarget";

/** A Today row's destination: the card that owns the task. */
export type TodayJumpTarget = "practice" | "sentences" | "words";

/**
 * The hero's one amber action (plan §4.5.11): the first open Today row, or
 * "Start a new video" once nothing is left. Only one thing is amber at a time.
 */
export const AMBER_ACTION =
  "border border-reward/40 bg-reward font-semibold text-hero shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_1px_2px_rgba(0,0,0,0.12)] transition-colors hover:bg-[#e2a544] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

// Every row has the same box: it bleeds 0.625rem past the panel's content edge on both
// sides and pads it back, so circles, labels and arrows line up whether a row is amber or
// quiet, with "Practice time" above and "Start a new video" below. (Both kinds have a 1px
// border, amber or transparent, so the padding gives that pixel back.)
const ROW_BASE = "group -mx-2.5 flex w-[calc(100%+1.25rem)] items-center gap-2.5 rounded-lg px-[calc(0.625rem-1px)] py-2 text-left text-sm";
const ROW_QUIET = "border border-transparent text-slate-100 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";
const ROW_NEXT = AMBER_ACTION;

interface TodayPlanProps {
  /** The goal part; undefined while loading (`weekPending`) or unavailable. */
  week: DashboardWeek | undefined;
  weekPending: boolean;
  rows: TodayRow[];
  allDone: boolean;
  /** Single out the first open row as the amber "start here" (every source has answered). */
  highlightFirst: boolean;
  onChangeGoal: () => void;
  changeGoalRef: Ref<HTMLButtonElement>;
  /** Scroll to and focus the card that owns a task. */
  onJump: (target: TodayJumpTarget) => void;
  /** With nothing unfinished, the practice row opens the app's one New video dialog. */
  onStartNewVideo: () => void;
}

const TARGET_ID: Record<TodayJumpTarget, string> = { practice: "continue-card", sentences: "continue-sentences", words: "review-deck" };
const TARGET_NAME: Record<TodayJumpTarget, string> = {
  practice: "go to Continue learning",
  sentences: "go to the sentences",
  words: "go to the review deck",
};

function RowLabel({ label, next, trailing }: { label: string; next: boolean; trailing: "jump" | "add" }) {
  const Trailing = trailing === "jump" ? ArrowDown : Plus;
  return (
    <>
      <Circle size={14} strokeWidth={2.5} aria-hidden="true" className={clsx("shrink-0", next ? "text-hero" : "text-reward")} />
      {/* Wraps rather than cutting the task off on a narrow phone. */}
      <span className="min-w-0 flex-1 leading-snug">{label}</span>
      <Trailing size={14} aria-hidden="true" className={clsx("shrink-0 transition-colors", next ? "text-hero" : "text-slate-400 group-hover:text-white")} />
    </>
  );
}

/** An open task: the whole row jumps to the card where it's done. */
function JumpRow({ target, label, next, onJump }: { target: TodayJumpTarget; label: string; next: boolean; onJump: TodayPlanProps["onJump"] }) {
  return (
    <a
      href={`#${TARGET_ID[target]}`}
      data-testid={`today-row-${target}`}
      data-next={next || undefined}
      aria-label={`${label}, ${TARGET_NAME[target]}`}
      onClick={(e) => {
        e.preventDefault();
        onJump(target);
      }}
      className={clsx(ROW_BASE, next ? ROW_NEXT : ROW_QUIET)}
    >
      <RowLabel label={label} next={next} trailing="jump" />
    </a>
  );
}

/**
 * The hero's Today list (plan §4.5.9, §4.5.11): practice time toward the
 * daily goal, then what's left today — minutes still to practise (resume the
 * Continue video, or start one when nothing is unfinished), sentences to look
 * at again, words to review — each going to the ONE card that owns the task,
 * and "All done for today ✓" once everything is clear. The first open row is
 * the hero's amber "start here". Nothing it can't know is shown as zero or as
 * done.
 */
export function TodayPlan({ week, weekPending, rows, allDone, highlightFirst, onChangeGoal, changeGoalRef, onJump, onStartNewVideo }: TodayPlanProps) {
  if (!week && !weekPending && rows.length === 0) return null;
  const nextIndex = highlightFirst ? rows.findIndex(isOpenRow) : -1;
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
        <ul aria-label="Today's tasks" className="space-y-1 border-t border-white/10 pt-2.5">
          {rows.map((row, i) => {
            const next = i === nextIndex;
            if (!isOpenRow(row)) {
              return (
                <li key="words" data-testid="today-row-words" data-done="true" className="flex items-center gap-2.5 py-2 text-sm text-slate-300">
                  <CircleCheck size={14} strokeWidth={2.5} aria-hidden="true" className="shrink-0 text-success" />
                  {row.reviewed} {row.reviewed === 1 ? "word" : "words"} reviewed today
                </li>
              );
            }
            if (row.kind === "practice" && row.via === "new-video") {
              // Nothing unfinished: practising starts with a new video (the New video dialog).
              return (
                <li key="practice">
                  <button
                    type="button"
                    data-testid="today-row-practice"
                    data-next={next || undefined}
                    onClick={onStartNewVideo}
                    aria-haspopup="dialog"
                    aria-label={`${row.headline}, start a new video`}
                    className={clsx(ROW_BASE, next ? ROW_NEXT : ROW_QUIET)}
                  >
                    <RowLabel label={row.headline} next={next} trailing="add" />
                  </button>
                </li>
              );
            }
            return (
              <li key={row.kind}>
                <JumpRow target={row.kind} label={row.headline} next={next} onJump={onJump} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
