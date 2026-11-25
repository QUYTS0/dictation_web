"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/ToastProvider";
import { goalProgress } from "@/lib/dashboard/week";
import { pickCelebrations, readCelebrationMemory, writeCelebrationMemory } from "@/lib/dashboard/celebrations";
import { formatXp } from "@/lib/xp/levels";
import type { DashboardWeek } from "@/lib/types/learning";
import type { XpSummary } from "@/lib/types/xp";

const BURST_MS = 3000;

/**
 * Goal-met and level-up celebrations on the Dashboard (plan §4.5.7): a
 * toast each, plus one confetti burst (rendered by the hero; nothing moves
 * under reduced motion, the toast still shows). Each goal date and level is
 * celebrated once per browser. Returns the burst's key while it plays.
 */
export function useDashboardCelebrations(userId: string | undefined, week: DashboardWeek | undefined, xp: XpSummary | undefined): number | null {
  const toast = useToast();
  const [burst, setBurst] = useState<number | null>(null);
  const today = week?.today ?? null;
  const goalMet = week ? goalProgress(week).met : false;
  const goalMinutes = week?.goalMinutes ?? null;
  const level = xp?.level ?? null;
  const totalXp = xp?.totalXp ?? null;

  useEffect(() => {
    if (!userId || (today === null && level === null)) return;
    const due = pickCelebrations(readCelebrationMemory(userId), { today, goalMet, level });
    writeCelebrationMemory(userId, due.next);
    if (due.goal) toast({ message: "Daily goal met!", sub: `${goalMinutes} min of practice today` });
    if (due.levelUp !== null) toast({ message: `Level ${due.levelUp} reached`, sub: totalXp !== null ? `${formatXp(totalXp)} XP in total` : undefined });
    // Syncing with an external store (localStorage): the burst starts only
    // after the remembered state says this is new.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (due.goal || due.levelUp !== null) setBurst(Date.now());
  }, [userId, today, goalMet, goalMinutes, level, totalXp, toast]);

  useEffect(() => {
    if (burst === null) return;
    const t = setTimeout(() => setBurst(null), BURST_MS);
    return () => clearTimeout(t);
  }, [burst]);

  return burst;
}
