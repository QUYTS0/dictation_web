"use client";

import { useQuery } from "@tanstack/react-query";
import type { ActivityStreak } from "@/lib/supabase/activityStreak";
import { streakQueryString } from "@/lib/queries/dashboard";

export const streakKeys = {
  streak: (userId: string | undefined) => ["streak", userId] as const,
};

/**
 * The daily practice streak from the lightweight /api/streak endpoint (not
 * the full dashboard summary). Shared by the app header (every signed-in
 * page) and the practice page's own header, so both read one cache entry.
 * Same server loader and the same browser timezone as the Dashboard, so all
 * three always show the same number.
 */
export function useStreakQuery(userId: string | undefined) {
  return useQuery({
    queryKey: streakKeys.streak(userId),
    queryFn: async (): Promise<ActivityStreak> => {
      const res = await fetch(`/api/streak${streakQueryString()}`);
      if (!res.ok) throw new Error("Failed to fetch streak");
      return res.json();
    },
    enabled: !!userId,
  });
}
