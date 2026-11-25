/** The tracks this app version knows, in display order (migration 049). */
export const ACHIEVEMENT_TRACK_IDS = ["flame_keeper", "precision_typist", "shadow_master", "lexicon", "immersion", "league"] as const;
export type AchievementTrackId = (typeof ACHIEVEMENT_TRACK_IDS)[number];
export type AchievementTierLevel = 1 | 2 | 3 | 4;

export const isKnownTrack = (track: unknown): track is AchievementTrackId =>
  typeof track === "string" && (ACHIEVEMENT_TRACK_IDS as readonly string[]).includes(track);

export interface AchievementTier {
  tier: AchievementTierLevel;
  /** In the track's unit (days, sentences, words, hours). From the database. */
  threshold: number;
  /** When it was first seen met; null = locked. */
  unlockedAt: string | null;
}

export interface AchievementTrack {
  track: AchievementTrackId;
  /** The track's current metric, computed server-side. */
  value: number;
  tiers: AchievementTier[];
}

export interface AchievementUnlock {
  track: AchievementTrackId;
  tier: AchievementTierLevel;
  unlockedAt: string;
}

/** GET /api/achievements (fn_sync_achievements, migration 049). */
export interface AchievementsResponse {
  tracks: AchievementTrack[];
  /** What this request recorded — announced once. */
  newlyUnlocked: AchievementUnlock[];
}
