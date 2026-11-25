import { Zap } from "lucide-react";
import { formatXp } from "@/lib/xp/levels";

/**
 * The header's XP pill (plan §1): "4,850 XP · Lvl 14". Hidden below `lg`,
 * as in the reference — the Dashboard hero shows the level bar at every
 * width. XP is calculated from practice records (migration 048).
 */
export function XpPill({ totalXp, level }: { totalXp: number; level: number }) {
  return (
    <span
      data-testid="header-xp"
      role="img"
      aria-label={`${formatXp(totalXp)} XP, level ${level}`}
      className="hidden shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-ink lg:flex"
    >
      <Zap size={14} aria-hidden="true" className="fill-primary-500/25 text-primary-600" />
      <span aria-hidden="true" className="whitespace-nowrap font-mono text-xs font-bold tabular-nums">
        {formatXp(totalXp)} XP <span className="font-sans font-medium text-muted">·</span> Lvl {level}
      </span>
    </span>
  );
}
