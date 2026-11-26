"use client";

import { useState } from "react";
import { useCountUp } from "@/hooks/useCountUp";
import { formatXp, levelProgress } from "@/lib/xp/levels";
import type { XpSummary } from "@/lib/types/xp";

/**
 * The hero's level bar (plan §1): "Level 14 · 4,850 / 5,000 XP" — total XP
 * against the next level's threshold, the bar showing progress through the
 * current level. Visually quieter than Today's target, as in the reference.
 * When the XP goes up while the page is open (e.g. it refetches after a
 * practice session), the number counts up and the gain floats up once.
 */
export function LevelProgress({ xp }: { xp: XpSummary }) {
  const { level, nextLevelXp, pct } = levelProgress(xp.totalXp);
  const shownXp = useCountUp(xp.totalXp);
  // The gain since the last value seen here (state adjusted during render,
  // so no effect is needed); cleared once its float has played.
  const [prevXp, setPrevXp] = useState(xp.totalXp);
  const [gain, setGain] = useState<number | null>(null);
  if (xp.totalXp !== prevXp) {
    setPrevXp(xp.totalXp);
    setGain(xp.totalXp > prevXp ? xp.totalXp - prevXp : null);
  }

  return (
    <div data-testid="hero-level" className="border-t border-white/10 pt-3">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-slate-200">
          <span className="inline-block h-2 w-2 rounded-full bg-primary-600" aria-hidden="true" />
          Level {level}
        </span>
        <span data-testid="hero-level-xp" className="relative font-mono text-[11px] tabular-nums text-[#c7cbfa]">
          {gain !== null && (
            <span
              key={xp.totalXp}
              aria-hidden="true"
              onAnimationEnd={() => setGain(null)}
              className="animate-xp-gain pointer-events-none absolute -top-4 right-0 whitespace-nowrap font-bold text-reward"
            >
              +{formatXp(gain)} XP
            </span>
          )}
          <span aria-hidden="true">
            {formatXp(shownXp)} / {formatXp(nextLevelXp)} XP
          </span>
          <span className="sr-only">
            {formatXp(xp.totalXp)} XP of {formatXp(nextLevelXp)} for level {level + 1}
          </span>
        </span>
      </div>
      <div aria-hidden="true" className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="animate-progress-fill h-full rounded-full bg-primary-600 opacity-90" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
