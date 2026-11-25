"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast, type ToastInput } from "@/components/ToastProvider";
import { unlockLabel } from "@/lib/achievements/catalog";
import { ACHIEVEMENTS_QUERY_ROOT } from "@/lib/queries/achievements";
import type { AchievementsResponse, AchievementUnlock } from "@/lib/types/achievements";

/** At most two toasts per response; more (e.g. a learner's first sync with
 *  a long history) are summed up in one. */
export function unlockToasts(unlocks: AchievementUnlock[]): ToastInput[] {
  if (unlocks.length === 0) return [];
  if (unlocks.length <= 2) return unlocks.map((u) => ({ message: "Achievement unlocked", sub: unlockLabel(u) }));
  const names = unlocks.slice(0, 3).map(unlockLabel);
  const more = unlocks.length - names.length;
  return [{ message: `${unlocks.length} achievements unlocked`, sub: more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ") }];
}

/**
 * Announces achievement unlocks app-wide (plan §5, Phase 6). Every
 * achievements fetch records newly met tiers and lists them in that
 * response only (fn_sync_achievements, migration 049), so one cache
 * subscriber here toasts each response's unlocks exactly once — however
 * many components read the query. Mounted once in Providers.
 */
export function AchievementUnlockNotifier() {
  const queryClient = useQueryClient();
  const toast = useToast();

  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
        if (event.query.queryKey[0] !== ACHIEVEMENTS_QUERY_ROOT) return;
        const data = event.action.data as AchievementsResponse | undefined;
        for (const t of unlockToasts(data?.newlyUnlocked ?? [])) toast(t);
      }),
    [queryClient, toast]
  );

  return null;
}
