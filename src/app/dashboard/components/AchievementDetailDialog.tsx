"use client";

import clsx from "clsx";
import { Check, Lock, X } from "lucide-react";
import { ModalDialog } from "@/components/ModalDialog";
import { TIER_NAMES, TRACKS } from "@/lib/achievements/catalog";
import type { AchievementTrack } from "@/lib/types/achievements";

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * One track's details (plan §1, BadgeDetailModal): what counts, the current
 * number, and every tier with its threshold — unlocked ones with the date
 * they were unlocked, locked ones with how far there is to go. No XP: badges
 * award none.
 */
export function AchievementDetailDialog({ track, onClose }: { track: AchievementTrack; onClose: () => void }) {
  const info = TRACKS[track.track];
  const Icon = info.icon;
  const titleId = `achievement-${track.track}-title`;

  return (
    <ModalDialog labelledBy={titleId} onClose={onClose} panelClassName="max-w-md">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-hero-2 bg-hero text-reward" aria-hidden="true">
            <Icon size={18} />
          </span>
          <div>
            <h2 id={titleId} className="text-lg font-bold text-ink">
              {info.name}
            </h2>
            <p className="mt-0.5 text-sm text-muted">{info.description}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${info.name}`}
          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <p data-testid="achievement-value" className="mb-3 rounded-xl bg-surface px-4 py-3 text-sm text-ink">
        {info.metricLabel}: <span className="font-mono font-bold">{info.format(track.value)}</span>
      </p>

      <ol aria-label={`${info.name} tiers`} className="space-y-2">
        {[...track.tiers]
          .sort((a, b) => a.tier - b.tier)
          .map((t) => {
            const unlocked = !!t.unlockedAt;
            return (
              <li
                key={t.tier}
                data-testid={`achievement-tier-${t.tier}`}
                className={clsx("flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm", unlocked ? "border-success/40 bg-success/5" : "border-line")}
              >
                <span className="flex items-center gap-2 font-semibold text-ink">
                  {unlocked ? <Check size={15} className="text-success" aria-hidden="true" /> : <Lock size={14} className="text-muted" aria-hidden="true" />}
                  {TIER_NAMES[t.tier]} · {info.format(t.threshold)}
                </span>
                <span className="text-xs text-muted">
                  {unlocked ? `Unlocked ${formatDate(t.unlockedAt!)}` : `${(info.formatToGo ?? info.format)(Math.max(0, t.threshold - track.value))} to go`}
                </span>
              </li>
            );
          })}
      </ol>
    </ModalDialog>
  );
}
