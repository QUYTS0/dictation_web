"use client";

import { useEffect, useState } from "react";
import { CalendarCheck, X } from "lucide-react";
import { claimWeeklyRecap } from "@/lib/dashboard/celebrations";
import { activeMinutes } from "@/lib/dashboard/week";
import { formatXp } from "@/lib/xp/levels";
import type { XpSummary } from "@/lib/types/xp";

/** "Last week: 1,240 XP · 96 min · 41 words reviewed" — zero parts left out. */
export function weeklyRecapText(last: XpSummary["lastLeagueWeek"]): string {
  const minutes = activeMinutes(Number(last.activeSec) || 0);
  const parts = [
    `${formatXp(last.xp)} XP`,
    minutes > 0 ? `${minutes} min` : null,
    last.wordsReviewed > 0 ? `${last.wordsReviewed} ${last.wordsReviewed === 1 ? "word" : "words"} reviewed` : null,
  ].filter(Boolean);
  return `Last week: ${parts.join(" · ")}`;
}

/**
 * The Monday recap (plan §4.5.7): last league week's XP, active time and
 * words reviewed, above the hero on the first Dashboard visit of a new
 * league week (Monday 00:00 UTC), once per week in this browser;
 * dismissible. Hidden when last week earned no XP (no activity). Phase 7
 * adds the league result.
 */
export function WeeklyRecapBanner({ userId, xp }: { userId: string; xp: XpSummary }) {
  const [visible, setVisible] = useState(false);
  const weekKey = new Date(xp.leagueWeekStart).toISOString().slice(0, 10);
  const hadActivity = xp.lastLeagueWeek.xp > 0;

  useEffect(() => {
    // Claimed (remembered) on first show: a later visit this week won't show it again.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (hadActivity && claimWeeklyRecap(userId, weekKey)) setVisible(true);
  }, [userId, weekKey, hadActivity]);

  if (!visible) return null;
  return (
    <section
      data-testid="weekly-recap"
      aria-label="Last week"
      className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-xs"
    >
      <CalendarCheck size={18} className="shrink-0 text-success" aria-hidden="true" />
      <p className="min-w-0 flex-1 font-medium">{weeklyRecapText(xp.lastLeagueWeek)}</p>
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label="Dismiss last week's summary"
        className="rounded-lg p-1 text-muted transition-colors hover:bg-surface hover:text-ink"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </section>
  );
}
