import type { LeagueLastWeek, LeagueTier, LeagueWeekBoard } from "@/lib/types/leaderboard";

/**
 * League presentation (plan §3.5). The rules themselves live in the database
 * (migration 050): weekly XP ranks a group of ≤ 30; the top 3 move up (not
 * from Master), the bottom 3 move down when ≥ 10 are ranked (not from
 * Bronze). These constants only describe them in copy.
 */
export const LEAGUE_TIERS: readonly LeagueTier[] = [1, 2, 3, 4, 5, 6];
export const LEAGUE_TIER_NAMES: Record<LeagueTier, string> = { 1: "Bronze", 2: "Silver", 3: "Gold", 4: "Platinum", 5: "Diamond", 6: "Master" };
export const PROMOTION_COUNT = 3;
export const DEMOTION_COUNT = 3;
export const DEMOTION_MIN_GROUP = 10;

export const leagueName = (tier: number) => LEAGUE_TIER_NAMES[tier as LeagueTier] ?? "League";
const higher = (tier: LeagueTier) => leagueName(Math.min(6, tier + 1));
const lower = (tier: LeagueTier) => leagueName(Math.max(1, tier - 1));

/** "LN" from "Linh Nguyen"; one letter for a single word. Never empty. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = Array.from(words[0] ?? "?")[0] ?? "?";
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** "Mon 07:00" — when the week resets, in the viewer's own time. */
export function formatLeagueReset(weekEndsAt: string): string {
  const at = new Date(weekEndsAt);
  const day = at.toLocaleDateString(undefined, { weekday: "short" });
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${time}`;
}

/** "finished #2 → promoted to Gold" — last week's result (the Monday recap). */
export function lastWeekResultText(last: LeagueLastWeek): string {
  if (last.outcome === "promoted") return `finished #${last.finalRank ?? "?"} → promoted to ${higher(last.tier)}`;
  if (last.outcome === "demoted") return `finished #${last.finalRank ?? "?"} → moved down to ${lower(last.tier)}`;
  return last.finalRank ? `finished #${last.finalRank} in ${leagueName(last.tier)}` : `stayed in ${leagueName(last.tier)}`;
}

/** The card's footer line: where the learner stands against this week's rule. */
export function zoneText(board: LeagueWeekBoard): string | null {
  const you = board.you;
  if (board.status !== "member" || !you) return null;
  if (you.zone === "promotion") return `Promotion zone: the top ${PROMOTION_COUNT} move up to ${higher(board.tier)}.`;
  if (you.zone === "demotion") return `Demotion zone: the bottom ${DEMOTION_COUNT} move down to ${lower(board.tier)}.`;
  if (board.tier === 6) return "Master is the top league: keep your place.";
  if (you.gapToPromotionXp !== null) return `${you.gapToPromotionXp.toLocaleString()} XP to the promotion zone (top ${PROMOTION_COUNT} move up to ${higher(board.tier)}).`;
  return null;
}
