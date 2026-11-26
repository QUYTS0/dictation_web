"use client";

import { Zap } from "lucide-react";
import { useCountUp } from "@/hooks/useCountUp";
import { formatXp } from "@/lib/xp/levels";

/**
 * The header's XP pill (plan §1): "4,850 XP · Lvl 14". Hidden below `xl`:
 * from 1024px to 1279px the one-row header has no room for it next to the
 * six nav tabs. The Dashboard hero shows the level bar at every width.
 * XP is calculated from practice records (migration 048). A change counts
 * up on screen; the accessible name always has the real value.
 */
export function XpPill({ totalXp, level }: { totalXp: number; level: number }) {
  const shownXp = useCountUp(totalXp);
  return (
    <span
      data-testid="header-xp"
      role="img"
      aria-label={`${formatXp(totalXp)} XP, level ${level}`}
      className="hidden shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-ink xl:flex"
    >
      <Zap size={14} aria-hidden="true" className="fill-primary-500/25 text-primary-600" />
      <span aria-hidden="true" className="whitespace-nowrap font-mono text-xs font-bold tabular-nums">
        {formatXp(shownXp)} XP <span className="font-sans font-medium text-muted">·</span> Lvl {level}
      </span>
    </span>
  );
}
