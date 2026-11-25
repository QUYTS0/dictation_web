"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ReviewGrade, VocabularyItem, VocabularyStatsResponse, VocabularyUpdateRequest } from "@/lib/types";
import { dashboardKeys } from "@/lib/queries/dashboard";
import { streakKeys } from "@/lib/queries/streak";
import { xpKeys } from "@/lib/queries/xp";
import { viewerTimeZone } from "@/lib/utils/streak";

export const vocabularyKeys = {
  items: (userId: string | undefined) => ["vocabulary-items", userId] as const,
  stats: (userId: string | undefined) => ["vocabulary-stats", userId] as const,
  reviewQueue: (userId: string | undefined) => ["vocabulary-review-queue", userId] as const,
};

/**
 * The current review batch (GET /api/vocabulary/review: up to 20 items
 * admissible now, `next_review_at` ascending). Not refetched on focus: a
 * session works through the batch it loaded, and graded items leave it
 * locally — a refetch mid-session would reshuffle the cards under the
 * learner. A fresh batch is loaded on the next visit (staleTime 60s).
 */
export function useVocabularyReviewQueueQuery(userId: string | undefined) {
  return useQuery({
    queryKey: vocabularyKeys.reviewQueue(userId),
    queryFn: async (): Promise<VocabularyItem[]> => {
      const res = await fetch("/api/vocabulary/review");
      if (!res.ok) throw new Error("Failed to load review items");
      const data = (await res.json()) as { items?: VocabularyItem[] };
      return data.items ?? [];
    },
    enabled: !!userId,
    refetchOnWindowFocus: false,
  });
}

/**
 * Grades one review (POST /api/vocabulary/review) with the viewer's
 * timezone, which decides the local day the review counts for in the streak
 * (migration 046). Throws with the server's message on failure.
 */
export async function submitVocabularyReview(itemId: string, grade: ReviewGrade): Promise<VocabularyItem> {
  const res = await fetch("/api/vocabulary/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemId, grade, timeZone: viewerTimeZone() ?? undefined }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; item?: VocabularyItem };
  if (!res.ok || !data.item) throw new Error(data.error || "Failed to save review.");
  return data.item;
}

/**
 * After a confirmed grade: the Vocabulary Bank and its counts, and — since
 * a review is a practice day (046) — the streak (header pill, footer), the
 * Dashboard summary and its weekly track (today's ✓), and XP (048). The
 * review queue itself is left alone (see above).
 */
export function invalidateAfterVocabularyReview(queryClient: QueryClient, userId: string | undefined) {
  invalidateVocabularyQueries(queryClient, userId);
  void queryClient.invalidateQueries({ queryKey: streakKeys.streak(userId) });
  void queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(userId) });
  void queryClient.invalidateQueries({ queryKey: dashboardKeys.week(userId) });
  void queryClient.invalidateQueries({ queryKey: xpKeys.xp(userId) });
}

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

/**
 * Mirrors useDeleteVocabularyItemMutation's shape, but for N ids in one
 * request/one cache patch/one stats invalidation instead of N of each — see
 * POST /api/vocabulary/bulk-delete. The mutation's result is the server's
 * own `deletedIds` (not an echo of the request), since a caller-owned id
 * that no longer exists is silently excluded rather than an error.
 */
export function useBulkDeleteVocabularyItemsMutation(userId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]): Promise<string[]> => {
      const res = await fetch("/api/vocabulary/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; deletedIds?: string[] };
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete vocabulary items.");
      }
      return data.deletedIds ?? [];
    },
    onSuccess: (deletedIds) => {
      const deleted = new Set(deletedIds);
      queryClient.setQueryData<VocabularyItem[]>(vocabularyKeys.items(userId), (old) =>
        old?.filter((item) => !deleted.has(item.id))
      );
      void queryClient.invalidateQueries({ queryKey: vocabularyKeys.stats(userId) });
    },
  });
}
