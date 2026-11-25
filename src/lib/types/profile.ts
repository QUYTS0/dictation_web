/** GET/PATCH /api/profile (fn_my_profile, migration 047). */
export interface UserProfile {
  /** Optional name for the public boards (Phase 7); null = `nickname`. */
  publicName: string | null;
  /** The stable generated pseudonym ("Learner 4F2A2"). */
  nickname: string;
  /** Left out of every public board (Phase 7). */
  leaderboardHidden: boolean;
  /** Null = the app default (DEFAULT_DAILY_GOAL_MINUTES). */
  dailyGoalMinutes: number | null;
}

/** PATCH /api/profile body: only the keys present change; null clears. */
export type UserProfilePatch = Partial<Pick<UserProfile, "publicName" | "leaderboardHidden" | "dailyGoalMinutes">>;
