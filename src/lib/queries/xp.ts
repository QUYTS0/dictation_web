"use client";

import { useQuery } from "@tanstack/react-query";
import { streakQueryString } from "@/lib/queries/dashboard";
import type { XpSummary } from "@/lib/types/xp";

export const xpKeys = {
  xp: (userId: string | undefined) => ["xp", userId] as const,
};

/**
 * The learner's XP and level (GET /api/xp, migration 048) — shared by the
 * header pill (every signed-in page) and the Dashboard, so both read one
 * cache entry. Any failure (e.g. 048 not applied) hides the XP parts.
 */
export function useXpQuery(userId: string | undefined) {
  return useQuery({
    queryKey: xpKeys.xp(userId),
    queryFn: async (): Promise<XpSummary> => {
      const res = await fetch(`/api/xp${streakQueryString()}`);
      if (!res.ok) throw new Error("Failed to fetch XP");
      const data = (await res.json()) as Partial<XpSummary> | null;
      if (!data || typeof data.totalXp !== "number" || typeof data.level !== "number" || !Array.isArray(data.days) || !data.lastLeagueWeek) {
        throw new Error("Unexpected XP response");
      }
      return data as XpSummary;
    },
    enabled: !!userId,
  });
}
