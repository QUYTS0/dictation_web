/**
 * Levels (plan §3.3): reaching level L takes 50·L·(L−1) total XP — level 2
 * at 100, level 5 at 1,000, level 10 at 4,500, level 20 at 19,000. Level 1
 * starts at 0. Shown as "Level N", no titles. XP itself is calculated by
 * the database (fn_my_xp, migration 048, rules v1).
 */
export const XP_RULES_VERSION = 1;

/** Total XP needed to reach `level` (≥ 1). */
export const xpForLevel = (level: number): number => 50 * level * (level - 1);

/** The level a total XP is at. */
export function levelForXp(totalXp: number): number {
  const xp = Math.max(0, Math.floor(totalXp));
  // Closed form of 50·L·(L−1) ≤ xp, then nudged so float rounding can never
  // be off by one at a boundary.
  let level = Math.max(1, Math.floor((1 + Math.sqrt(1 + 0.08 * xp)) / 2));
  while (xpForLevel(level + 1) <= xp) level += 1;
  while (level > 1 && xpForLevel(level) > xp) level -= 1;
  return level;
}

export interface LevelProgress {
  level: number;
  /** Total XP at which this level started. */
  levelStartXp: number;
  /** Total XP at which the next level starts. */
  nextLevelXp: number;
  /** 0–100 through the current level. */
  pct: number;
}

export function levelProgress(totalXp: number): LevelProgress {
  const xp = Math.max(0, Math.floor(totalXp));
  const level = levelForXp(xp);
  const levelStartXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  return { level, levelStartXp, nextLevelXp, pct: Math.min(100, (100 * (xp - levelStartXp)) / (nextLevelXp - levelStartXp)) };
}

/** "4,850" — grouped digits in the viewer's locale. */
export const formatXp = (xp: number): string => Math.round(xp).toLocaleString();
