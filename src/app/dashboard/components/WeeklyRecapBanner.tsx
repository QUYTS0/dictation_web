"use client";

import { useEffect, useState } from "react";
import { CalendarCheck, X } from "lucide-react";
import { claimWeeklyRecap } from "@/lib/dashboard/celebrations";
import { activeMinutes } from "@/lib/dashboard/week";
import { lastWeekResultText } from "@/lib/leagues/tiers";
import { formatXp } from "@/lib/xp/levels";
import type { LeagueLastWeek } from "@/lib/types/leaderboard";
import type { XpSummary } from "@/lib/types/xp";

/** "Last week: 1,240 XP · 96 min · 41 words reviewed · finished #2 → promoted
 *  to Gold" — zero parts left out; the league part only after a league week. */
export function weeklyRecapText(last: XpSummary["lastLeagueWeek"], league: LeagueLastWeek | null = null): string {
  const minutes = activeMinutes(Number(last.activeSec) || 0);
  const parts = [
    `${formatXp(last.xp)} XP`,
    minutes > 0 ? `${minutes} min` : null,
    last.wordsReviewed > 0 ? `${last.wordsReviewed} ${last.wordsReviewed === 1 ? "word" : "words"} reviewed` : null,
    league && league.weekStart === last.weekStart ? lastWeekResultText(league) : null,
  ].filter(Boolean);
  return `Last week: ${parts.join(" · ")}`;
}

/**
 * The Monday recap (plan §4.5.7): last league week's XP, active time and
 * words reviewed, above the hero on the first Dashboard visit of a new
 * league week (Monday 00:00 UTC), once per week in this browser;
 * dismissible. Hidden when last week earned no XP (no activity). Adds last
 * week's league result once the board has loaded.
 */
export function WeeklyRecapBanner({ userId, xp, leagueLastWeek = null }: { userId: string; xp: XpSummary; leagueLastWeek?: LeagueLastWeek | null }) {
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
      <p className="min-w-0 flex-1 font-medium">{weeklyRecapText(xp.lastLeagueWeek, leagueLastWeek)}</p>
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
