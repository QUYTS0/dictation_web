/** 1 Bronze · 2 Silver · 3 Gold · 4 Platinum · 5 Diamond · 6 Master (migration 050). */
export type LeagueTier = 1 | 2 | 3 | 4 | 5 | 6;
export type LeagueZone = "promotion" | "demotion" | "safe";
export type LeagueOutcome = "promoted" | "stayed" | "demoted";
export type LeagueScope = "week" | "all";

/** The learner's result in the previous league week (finalized). */
export interface LeagueLastWeek {
  weekStart: string;
  /** The tier they played in. */
  tier: LeagueTier;
  outcome: LeagueOutcome;
  /** Null when they were hidden at rollover (not ranked). */
  finalRank: number | null;
  xp: number | null;
}

interface LeagueBoardBase {
  /** member: placed in a group (week) / ranked view (all) · not_joined: no XP
   *  this week yet · hidden: left out of every board (and sees none). */
  status: "member" | "not_joined" | "hidden";
  tier: LeagueTier;
  /** Monday (UTC) of the current league week. */
  weekStart: string;
  /** ISO instant: next Monday 00:00 UTC. */
  weekEndsAt: string;
  /** How the learner appears: public name or generated nickname. */
  displayName: string;
  lastWeek: LeagueLastWeek | null;
}

/** One member of the caller's group. Never an email, user id or avatar. */
export interface LeagueWeekRow {
  rank: number;
  /** Opaque, this week only — what kudos are given to. */
  memberKey: string;
  name: string;
  initials: string;
  weekXp: number;
  /** The caller's own row: their viewer-local streak (same as the header). */
  streakDays: number;
  kudos: number;
  youGaveKudos: boolean;
  isYou: boolean;
  zone: LeagueZone;
}

export interface LeagueWeekBoard extends LeagueBoardBase {
  scope: "week";
  rows: LeagueWeekRow[];
  you: { rank: number; weekXp: number; zone: LeagueZone; gapToPromotionXp: number | null } | null;
}

export interface LeagueAllTimeRow {
  rank: number;
  name: string;
  initials: string;
  totalXp: number;
  isYou: boolean;
}

export interface LeagueAllTimeBoard extends LeagueBoardBase {
  scope: "all";
  /** Global top 5 from the hourly snapshot. */
  rows: LeagueAllTimeRow[];
  you: { rank: number; totalXp: number } | null;
  refreshedAt: string | null;
}

export type LeagueBoard = LeagueWeekBoard | LeagueAllTimeBoard;
