"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardKeys } from "@/lib/queries/dashboard";
import type { UserProfile, UserProfilePatch } from "@/lib/types/profile";

export const profileKeys = {
  profile: (userId: string | undefined) => ["profile", userId] as const,
};

/** The learner's preferences (GET /api/profile, migration 047). */
export function useProfileQuery(userId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: profileKeys.profile(userId),
    queryFn: async (): Promise<UserProfile> => {
      const res = await fetch("/api/profile");
      if (!res.ok) throw new Error("Failed to load your preferences");
      return res.json();
    },
    enabled: !!userId && enabled,
  });
}

/**
 * Saves a preference patch (PATCH /api/profile). On success the profile
 * cache takes the server's answer, and the Dashboard week (which carries the
 * goal) is refreshed. Scoped to the user the change was made for.
 */
export function useUpdateProfileMutation(userId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: UserProfilePatch): Promise<UserProfile> => {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json().catch(() => ({}))) as UserProfile & { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to save your preferences");
      return data;
    },
    onSuccess: (profile) => {
      queryClient.setQueryData(profileKeys.profile(userId), profile);
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.week(userId) });
    },
  });
}
