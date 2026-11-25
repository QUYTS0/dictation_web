import type { LucideIcon } from "lucide-react";
import { BookOpen, Flame, Headphones, Mic2, Target, Trophy } from "lucide-react";
import type { AchievementTier, AchievementTierLevel, AchievementTrack, AchievementTrackId, AchievementUnlock } from "@/lib/types/achievements";

/**
 * Presentation only (plan §3.4): names, icons and copy. Thresholds and what
 * counts live in the database (achievement_tiers, fn_sync_achievements —
 * migration 049); nothing here decides an unlock.
 */
export const TIER_NAMES: Record<AchievementTierLevel, string> = { 1: "Bronze", 2: "Silver", 3: "Gold", 4: "Diamond" };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** Hours rounded DOWN to a tenth, so "5 h" never shows before 5 hours. */
const hours = (h: number) => `${(Math.floor(h * 10) / 10).toLocaleString()} h`;

export interface TrackInfo {
  name: string;
  icon: LucideIcon;
  /** What the number is, e.g. "Longest streak". */
  metricLabel: string;
  description: string;
  format: (value: number) => string;
  /** How much is left to a threshold; defaults to `format`. */
  formatToGo?: (remaining: number) => string;
}

export const TRACKS: Record<AchievementTrackId, TrackInfo> = {
  flame_keeper: {
    name: "Flame Keeper",
    icon: Flame,
    metricLabel: "Longest streak",
    description: "Your longest run of days in a row with practice in any mode, word reviews included.",
    format: (n) => plural(n, "day", "days"),
  },
  precision_typist: {
    name: "Precision Typist",
    icon: Target,
    metricLabel: "Correct sentences",
    description: "Sentences whose latest Dictation answer is correct.",
    format: (n) => plural(n, "sentence", "sentences"),
  },
  shadow_master: {
    name: "Shadow Master",
    icon: Mic2,
    metricLabel: "Scored sentences",
    description: "Shadowing sentences with an Azure pronunciation score.",
    format: (n) => plural(n, "sentence", "sentences"),
  },
  lexicon: {
    name: "Lexicon",
    icon: BookOpen,
    metricLabel: "Saved words",
    description: "Words saved to your Vocabulary.",
    format: (n) => plural(n, "word", "words"),
  },
  immersion: {
    name: "Immersion",
    icon: Headphones,
    metricLabel: "Active practice",
    description: "Hours of active practice — an estimate, counted since tracking started.",
    format: hours,
    // Rounded UP, so what's left is never understated.
    formatToGo: (h) => `${(Math.ceil(h * 10) / 10).toLocaleString()} h`,
  },
  league: {
    name: "League",
    icon: Trophy,
    metricLabel: "Highest league",
    description: "The highest weekly league you've reached.",
    format: (n) => String(n),
  },
};

/** The highest unlocked tier, the next locked one above it, and progress
 *  toward it (value / its threshold). */
export function trackStatus(t: AchievementTrack): { current: AchievementTier | null; next: AchievementTier | null; pct: number } {
  const tiers = [...t.tiers].sort((a, b) => a.tier - b.tier);
  const unlocked = tiers.filter((x) => x.unlockedAt);
  const current = unlocked.length ? unlocked[unlocked.length - 1] : null;
  const next = tiers.find((x) => !x.unlockedAt && (!current || x.tier > current.tier)) ?? null;
  const pct = next ? Math.min(100, Math.max(0, (100 * t.value) / next.threshold)) : 100;
  return { current, next, pct };
}

/** "Flame Keeper · Silver" */
export const unlockLabel = (u: Pick<AchievementUnlock, "track" | "tier">) => `${TRACKS[u.track].name} · ${TIER_NAMES[u.tier]}`;

/**
 * The header streak popover's next milestone (plan §1): the first Flame
 * Keeper threshold above the CURRENT streak, or null past the last one.
 */
export function nextStreakMilestone(currentStreak: number, flame: AchievementTrack | undefined): { days: number; toGo: number } | null {
  const next = (flame?.tiers ?? []).map((t) => t.threshold).sort((a, b) => a - b).find((days) => days > currentStreak);
  return next === undefined ? null : { days: next, toGo: next - currentStreak };
}
