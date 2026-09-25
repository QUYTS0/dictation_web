"use client";

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import type { ErrorType } from "@/lib/types";

export interface MistakeItem {
  id: string;
  sessionId: string;
  videoId: string;
  videoTitle: string | null;
  segmentIndex: number;
  expectedText: string;
  userText: string;
  errorType: ErrorType | null;
  createdAt: string;
}

interface MistakesPage {
  items: MistakeItem[];
  hasMore: boolean;
  total: number;
}

export interface HistoryMistakesFilters {
  videoId: string;
  errorType: string;
  dateFrom: string;
  dateTo: string;
}

const PAGE_SIZE = 10;

export const historyMistakesKeys = {
  list: (userId: string | undefined, filters: HistoryMistakesFilters) =>
    ["history-mistakes", userId, filters] as const,
  /** Prefix key covering every cached filter combination for this user —
   *  pass to invalidateQueries (without `exact: true`) to invalidate all of
   *  them at once, e.g. after a practice session completes and its
   *  attempt_logs rows may now match filters the user hasn't even tried
   *  yet. */
  allForUser: (userId: string | undefined) => ["history-mistakes", userId] as const,
};

async function fetchMistakesPage(filters: HistoryMistakesFilters, offset: number): Promise<MistakesPage> {
  const searchParams = new URLSearchParams();
  if (filters.videoId) searchParams.set("videoId", filters.videoId);
  if (filters.errorType) searchParams.set("errorType", filters.errorType);
  if (filters.dateFrom) searchParams.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) searchParams.set("dateTo", filters.dateTo);
  searchParams.set("limit", String(PAGE_SIZE));
  searchParams.set("offset", String(offset));

  const res = await fetch(`/api/history/mistakes?${searchParams.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch mistakes");
  return res.json();
}

/**
 * GET /api/history/mistakes is already a real offset/limit paginated,
 * filtered endpoint (see that route) — a natural fit for useInfiniteQuery's
 * "load more" model instead of page-local `mistakes`/`hasMore`/`total`
 * useState. `placeholderData: keepPreviousData` keeps the previous filter's
 * results on screen while a new filter's first page loads, instead of
 * blanking the list mid-refetch.
 */
export function useHistoryMistakesQuery(userId: string | undefined, filters: HistoryMistakesFilters) {
  return useInfiniteQuery({
    queryKey: historyMistakesKeys.list(userId, filters),
    queryFn: ({ pageParam }) => fetchMistakesPage(filters, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined;
      return allPages.reduce((sum, page) => sum + page.items.length, 0);
    },
    enabled: !!userId,
    placeholderData: keepPreviousData,
  });
}
