"use client";

import { useRef, useState } from "react";
import clsx from "clsx";
import { Plus } from "lucide-react";
import { ConfettiBurst } from "@/components/ConfettiBurst";
import { ProfileDialog } from "@/components/ProfileDialog";
import type { TodayPlanResult } from "@/lib/dashboard/today";
import type { DashboardSummary, DashboardWeek } from "@/lib/types/learning";
import type { XpSummary } from "@/lib/types/xp";
import { LevelProgress } from "./LevelProgress";
import { StreakStatusLine } from "./StreakStatusLine";
import { AMBER_ACTION, TodayPlan, type TodayJumpTarget } from "./TodayPlan";
import { WeeklyTrack } from "./WeeklyTrack";

/** The navy hero surface (reference "Approved DictaLearn" hero). */
export const HERO_SURFACE_STYLE = {
  background:
    "radial-gradient(ellipse 70% 55% at 88% 12%, rgba(91, 92, 226, 0.15) 0%, rgba(91, 92, 226, 0) 70%), linear-gradient(135deg, #151b35 0%, #1b2145 52%, #25285c 100%)",
  border: "1px solid rgba(221, 227, 239, 0.12)",
} as const;

interface DashboardHeroProps {
  name: string;
  summary: DashboardSummary | undefined;
  /** The viewer's local days (track + target); undefined while loading or
   *  unavailable — `weekPending` tells which. */
  week: DashboardWeek | undefined;
  weekPending: boolean;
  /** XP and level; undefined while loading or unavailable (bar left out). */
  xp: XpSummary | undefined;
  /** What's left today, whether everything is clear, and the one amber action (plan §4.5.11). */
  today: TodayPlanResult;
  onJump: (target: TodayJumpTarget) => void;
  /** Key of a celebration confetti burst while it plays, else null. */
  celebrationBurst: number | null;
  /** Opens the app's one New video dialog (the header's). */
  onStartNewVideo: () => void;
}

/**
 * The returning learner's hero (plan §1, §4.5.1–2, §4.5.5, §4.5.11):
 * welcome, streak status, the weekly consistency track (XP per day) and the
 * level bar on the left; on the right, today's panel: the Today list
 * (practice time toward the goal, then what is left, each going to its card;
 * plan §4.5.9) and "Start a new video", which opens the app's one New video
 * dialog (the header's; NewVideoDialog).
 *
 * One amber action at a time: the first open Today row while something is
 * left ("start here"); "Start a new video" only once nothing is (otherwise it
 * is a quiet link — the header's New video is on every page too). When the
 * practice row itself starts a new video (nothing unfinished), it is the only
 * new-video control here. If the week or XP can't be loaded (e.g. migration
 * 047 / 048 not applied yet), their parts are left out — never shown as
 * zeros. Goal-met and level-up confetti plays inside the hero.
 */
export function DashboardHero({
  name,
  summary,
  week,
  weekPending,
  xp,
  today,
  onJump,
  celebrationBurst,
  onStartNewVideo,
}: DashboardHeroProps) {
  const [goalOpen, setGoalOpen] = useState(false);
  const changeGoalRef = useRef<HTMLButtonElement>(null);
  const newVideoInList = today.rows.some((r) => r.kind === "practice" && r.via === "new-video");
  const newVideoNext = today.next === "new-video";

  return (
    <section
      data-testid="dashboard-welcome"
      aria-labelledby="dashboard-welcome-heading"
      className="relative overflow-hidden rounded-2xl p-6 text-white shadow-md md:p-8"
      style={HERO_SURFACE_STYLE}
    >
      <div className="relative grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        <div className="min-w-0 space-y-3 lg:col-span-7">
          <h1 id="dashboard-welcome-heading" className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
            Welcome back, {name}
          </h1>
          <StreakStatusLine summary={summary} />
          {week ? (
            <WeeklyTrack week={week} xp={xp} />
          ) : weekPending ? (
            <div aria-hidden="true" data-testid="weekly-track-pending" className="h-[92px] max-w-3xl animate-pulse rounded-lg bg-white/[0.04]" />
          ) : null}
          {/* Lifetime progress, not today's: it sits with the week, not in the Today panel. */}
          {xp && (
            <div className="max-w-3xl pt-1">
              <LevelProgress xp={xp} />
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-4 rounded-xl border border-white/10 bg-white/[0.04] p-5 lg:col-span-5">
          <TodayPlan
            week={week}
            weekPending={weekPending}
            rows={today.rows}
            allDone={today.allDone}
            highlightFirst={today.next === "row"}
            onChangeGoal={() => setGoalOpen(true)}
            changeGoalRef={changeGoalRef}
            onJump={onJump}
            onStartNewVideo={onStartNewVideo}
          />
          {!newVideoInList && (
            // One element whether quiet or amber, so focus stays put when it changes. It opens
            // the same New video dialog as the header's button.
            <button
              type="button"
              data-testid="hero-new-video"
              data-next={newVideoNext || undefined}
              onClick={onStartNewVideo}
              aria-haspopup="dialog"
              className={clsx(
                "flex items-center gap-2.5 rounded-lg text-sm",
                newVideoNext
                  ? `w-full justify-center px-3 py-2.5 tracking-wide ${AMBER_ACTION}`
                  : // Quiet: its + lines up with the Today rows' circles.
                    "-mx-1 px-1 py-1 font-semibold text-slate-300 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              )}
            >
              <Plus size={newVideoNext ? 16 : 14} strokeWidth={2.5} aria-hidden="true" />
              Start a new video
            </button>
          )}
        </div>
      </div>
      {celebrationBurst !== null && <ConfettiBurst key={celebrationBurst} />}
      {goalOpen && <ProfileDialog onClose={() => setGoalOpen(false)} returnFocusRef={changeGoalRef} />}
    </section>
  );
}
