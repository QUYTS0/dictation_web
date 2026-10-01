import { useQuery } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import { streakQueryString } from "@/lib/queries/dashboard";

/**
 * Surfaces the user's daily practice streak inside Dictation Mode itself —
 * previously only visible on the dashboard — so quitting mid-session has a
 * visible cost. Uses the lightweight /api/streak endpoint rather than the
 * full dashboard summary, which this page doesn't otherwise need. Same
 * server loader and the same browser timezone as the Dashboard, so the two
 * always show the same number.
 */
export function useStreak(user: User | null) {
  const { data } = useQuery({
    queryKey: ["streak", user?.id],
    queryFn: async (): Promise<{ streakDays: number }> => {
      const res = await fetch(`/api/streak${streakQueryString()}`);
      if (!res.ok) throw new Error("Failed to fetch streak");
      return res.json();
    },
    enabled: !!user,
  });

  return { streakDays: data?.streakDays ?? 0 };
}
