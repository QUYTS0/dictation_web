"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { CheckCircle2, Flame } from "lucide-react";
import type { DashboardSummary } from "@/lib/types/learning";
import { localDayKey } from "@/lib/utils/streak";

/** From this local hour, a streak not yet kept today gets the urgent wording. */
export const STREAK_URGENT_HOUR = 18;

export type StreakTone = "neutral" | "done" | "nudge" | "urgent";

type StreakFields = Pick<DashboardSummary, "streakDays" | "streakActiveToday" | "streakToday" | "streakTimeZone">;

function localHour(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
}

/**
 * The one line under "Welcome back" (plan §4.5.2). Honest about the rule:
 * any practice on the viewer's local day keeps the streak. Evaluated in the
 * zone the server used for `streakToday`; if the local date has moved on
 * since (page left open past midnight), it makes no claim until the summary
 * refetches.
 */
export function streakStatus(s: StreakFields, now: Date): { tone: StreakTone; text: string } {
  const neutral = { tone: "neutral" as const, text: "Ready for today's practice?" };
  if (s.streakDays <= 0 || localDayKey(now, s.streakTimeZone) !== s.streakToday) return neutral;
  const n = s.streakDays;
  if (s.streakActiveToday) return { tone: "done", text: `${n}-day streak · today is done` };
  if (localHour(now, s.streakTimeZone) < STREAK_URGENT_HOUR) return { tone: "nudge", text: `Keep your ${n}-day streak going today.` };
  return { tone: "urgent", text: `Your ${n}-day streak ends at midnight. Any practice today keeps it going.` };
}

export function StreakStatusLine({ summary }: { summary: DashboardSummary | undefined }) {
  // The clock is re-read when the learner comes back to the tab and every
  // few minutes, so the 18:00 switch happens without a reload.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const update = () => setNow(new Date());
    const onVisibility = () => document.visibilityState === "visible" && update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(update, 5 * 60 * 1000);
    return () => {
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
  }, []);

  // Reserve the line's height while the summary loads, so nothing jumps.
  if (!summary) return <p className="h-6" aria-hidden="true" />;

  const { tone, text } = streakStatus(summary, now);
  const Icon = tone === "done" ? CheckCircle2 : tone === "neutral" ? null : Flame;
  return (
    <p
      data-testid="streak-status"
      data-tone={tone}
      className={clsx(
        "flex items-start gap-2 text-sm leading-relaxed sm:text-base",
        tone === "done" && "text-[#7fdcc9]",
        tone === "nudge" && "text-slate-200",
        tone === "urgent" && "font-medium text-reward",
        tone === "neutral" && "text-slate-300"
      )}
    >
      {Icon && <Icon size={18} aria-hidden="true" className={clsx("mt-0.5 shrink-0", tone !== "done" && "text-reward")} />}
      <span>{text}</span>
    </p>
  );
}
