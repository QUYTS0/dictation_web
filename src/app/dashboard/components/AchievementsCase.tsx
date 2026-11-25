"use client";

import { useState } from "react";
import clsx from "clsx";
import { Award } from "lucide-react";
import { TIER_NAMES, TRACKS, trackStatus } from "@/lib/achievements/catalog";
import type { AchievementTierLevel, AchievementTrack, AchievementTrackId } from "@/lib/types/achievements";
import { AchievementDetailDialog } from "./AchievementDetailDialog";

const TIER_ICON_CLASS: Record<AchievementTierLevel, string> = {
  1: "text-amber-600",
  2: "text-slate-300",
  3: "text-reward",
  4: "text-sky-300",
};

/**
 * The trophy case (plan §1, §3.4): one tile per track with its highest
 * unlocked tier and progress toward the next; a tile opens the track's
 * details. Unlocks are recorded and decided by the database — this only
 * shows them. Badges award no XP.
 */
export function AchievementsCase({ tracks }: { tracks: AchievementTrack[] }) {
  const [openTrack, setOpenTrack] = useState<AchievementTrackId | null>(null);
  const totalTiers = tracks.reduce((n, t) => n + t.tiers.length, 0);
  const unlockedTiers = tracks.reduce((n, t) => n + t.tiers.filter((x) => x.unlockedAt).length, 0);
  const selected = tracks.find((t) => t.track === openTrack);

  return (
    <section data-testid="achievements" aria-labelledby="achievements-heading" className="space-y-4 rounded-2xl border border-line bg-white p-5 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <h2 id="achievements-heading" className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink">
          <Award size={16} className="text-primary-600" aria-hidden="true" />
          Achievements
        </h2>
        <span data-testid="achievements-count" className="font-mono text-xs text-muted">
          {unlockedTiers}/{totalTiers} tiers
        </span>
      </div>

      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
        {tracks.map((t) => {
          const info = TRACKS[t.track];
          const Icon = info.icon;
          const { current, next, pct } = trackStatus(t);
          const tierLabel = current ? TIER_NAMES[current.tier] : "Locked";
          const toward = next ? (info.describeProgress ? info.describeProgress(t.value, next.threshold) : `${info.format(t.value)} of ${info.format(next.threshold)}`) : null;
          const progress = next ? `${toward} for ${TIER_NAMES[next.tier]}` : "every tier unlocked";
          return (
            <li key={t.track}>
              <button
                type="button"
                data-testid={`achievement-${t.track}`}
                data-unlocked={!!current}
                onClick={() => setOpenTrack(t.track)}
                aria-haspopup="dialog"
                aria-label={`${info.name}: ${tierLabel}, ${progress}`}
                className={clsx(
                  "flex min-h-[104px] w-full flex-col items-center justify-between gap-2 rounded-xl border p-2.5 text-center transition-colors hover:border-primary-500/40",
                  current ? "border-line bg-white" : "border-line bg-surface"
                )}
              >
                <span className="relative my-auto" aria-hidden="true">
                  <span
                    className={clsx(
                      "flex h-9 w-9 items-center justify-center rounded-xl border",
                      current ? "border-hero-2 bg-hero" : "border-line bg-surface text-muted"
                    )}
                  >
                    <Icon size={16} className={clsx(current && TIER_ICON_CLASS[current.tier], current && t.track === "flame_keeper" && "fill-current")} />
                  </span>
                  {current && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-success ring-2 ring-white" />}
                </span>
                <span className="w-full" aria-hidden="true">
                  <span className="block truncate text-[11px] font-bold leading-tight text-ink">{info.name}</span>
                  <span className={clsx("block font-mono text-[10px]", current ? "text-ink" : "text-muted")}>{tierLabel}</span>
                  {next && (
                    <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-line">
                      <span className="block h-full rounded-full bg-primary-600" style={{ width: `${pct}%` }} />
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {selected && <AchievementDetailDialog track={selected} onClose={() => setOpenTrack(null)} />}
    </section>
  );
}
