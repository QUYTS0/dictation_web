"use client";

import { useQuery } from "@tanstack/react-query";
import type { AchievementsResponse } from "@/lib/types/achievements";

export const ACHIEVEMENTS_QUERY_ROOT = "achievements";

export const achievementsKeys = {
  achievements: (userId: string | undefined) => [ACHIEVEMENTS_QUERY_ROOT, userId] as const,
};

/**
 * The learner's achievements (GET /api/achievements, migration 049). Each
 * fetch also records newly met tiers; AchievementUnlockNotifier announces
 * them (once per response). Shared by the Dashboard's trophy case and the
 * header streak popover (`enabled` only while it's open).
 */
export function useAchievementsQuery(userId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: achievementsKeys.achievements(userId),
    queryFn: async (): Promise<AchievementsResponse> => {
      const res = await fetch("/api/achievements");
      if (!res.ok) throw new Error("Failed to load achievements");
      const data = (await res.json()) as Partial<AchievementsResponse> | null;
      if (!data || !Array.isArray(data.tracks) || !Array.isArray(data.newlyUnlocked)) throw new Error("Unexpected achievements response");
      return data as AchievementsResponse;
    },
    enabled: !!userId && enabled,
  });
}
