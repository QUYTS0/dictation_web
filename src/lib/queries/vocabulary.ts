"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { VocabularyItem, VocabularyStatsResponse, VocabularyUpdateRequest } from "@/lib/types";

export const vocabularyKeys = {
  items: (userId: string | undefined) => ["vocabulary-items", userId] as const,
  stats: (userId: string | undefined) => ["vocabulary-stats", userId] as const,
};

async function fetchVocabularyItems(): Promise<VocabularyItem[]> {
  const res = await fetch("/api/vocabulary");
  if (!res.ok) throw new Error("Failed to fetch vocabulary");
  const data = (await res.json()) as { items?: VocabularyItem[] };
  return data.items ?? [];
}

async function fetchVocabularyStats(): Promise<VocabularyStatsResponse> {
  const res = await fetch("/api/vocabulary/stats");
  if (!res.ok) throw new Error("Failed to fetch vocabulary stats");
  return res.json();
}

// Learning status/stats can change from a *different browser tab* (e.g.
// grading a review there) — that tab has its own separate QueryClient
// instance entirely, so its invalidateQueries call has zero effect here.
// The global staleTime (60s, see Providers.tsx) would otherwise let this
// tab go on showing pre-review status/counts for up to a minute after
// regaining focus. `refetchOnWindowFocus: "always"` forces a refetch on
// every focus regardless of staleTime, for just these two queries — no
// polling, and every other query keeps the default (focus-refetch only
// when actually stale).
const ALWAYS_REFETCH_ON_FOCUS = "always" as const;

export function useVocabularyItemsQuery(userId: string | undefined) {
  return useQuery({
    queryKey: vocabularyKeys.items(userId),
    queryFn: fetchVocabularyItems,
    enabled: !!userId,
    refetchOnWindowFocus: ALWAYS_REFETCH_ON_FOCUS,
  });
}

export function useVocabularyStatsQuery(userId: string | undefined) {
  return useQuery({
    queryKey: vocabularyKeys.stats(userId),
    queryFn: fetchVocabularyStats,
    enabled: !!userId,
    refetchOnWindowFocus: ALWAYS_REFETCH_ON_FOCUS,
  });
}

/**
 * Invalidates both vocabulary queries — call after any write to
 * `vocabulary_items` made from *outside* the Vocabulary Bank page itself
 * (the dictation page's save/edit/delete popover, and a completed review
 * grade), so the Bank's cache catches up the next time it's visited. The
 * Bank page's own edit/delete actions below patch the cache directly
 * instead, since they already have the exact updated/removed row in hand.
 */
export function invalidateVocabularyQueries(queryClient: QueryClient, userId: string | undefined) {
  void queryClient.invalidateQueries({ queryKey: vocabularyKeys.items(userId) });
  void queryClient.invalidateQueries({ queryKey: vocabularyKeys.stats(userId) });
}

export function useUpdateVocabularyItemMutation(userId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: VocabularyUpdateRequest): Promise<VocabularyItem> => {
      const res = await fetch("/api/vocabulary", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; item?: VocabularyItem };
      if (!res.ok || !data.item) {
        throw new Error(data.error || "Failed to update vocabulary item.");
      }
      return data.item;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<VocabularyItem[]>(vocabularyKeys.items(userId), (old) =>
        old?.map((item) => (item.id === updated.id ? updated : item))
      );
      // Editing note/translation/definition/etc. never changes SRS fields
      // (see PATCH /api/vocabulary — term-changed nulling excludes them
      // too), so `vocabulary-stats` never needs invalidating here.
    },
  });
}

export function useDeleteVocabularyItemMutation(userId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const res = await fetch(`/api/vocabulary?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to delete vocabulary item.");
      }
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<VocabularyItem[]>(vocabularyKeys.items(userId), (old) =>
        old?.filter((item) => item.id !== id)
      );
      // Total/New/Learning/Due all shift by one, but which bucket the
      // deleted item was in isn't known here — a cheap exact-count
      // refetch is simpler and safer than guessing.
      void queryClient.invalidateQueries({ queryKey: vocabularyKeys.stats(userId) });
    },
  });
}
