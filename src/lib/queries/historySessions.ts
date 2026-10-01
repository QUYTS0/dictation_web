"use client";

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import type { HistorySessionsPage } from "@/lib/types/learning";

export interface HistorySessionsFilters {
  videoId: string;
}

const PAGE_SIZE = 10;

export const historySessionsKeys = {
  list: (userId: string | undefined, filters: HistorySessionsFilters) => ["history-sessions", userId, filters] as const,
  /** Prefix covering every filter combination of this user. */
  allForUser: (userId: string | undefined) => ["history-sessions", userId] as const,
};

type Cursor = { startedAt: string; id: string } | null;

async function fetchSessionsPage(filters: HistorySessionsFilters, cursor: Cursor): Promise<HistorySessionsPage> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (filters.videoId) params.set("videoId", filters.videoId);
  if (cursor) {
    params.set("beforeStartedAt", cursor.startedAt);
    params.set("beforeId", cursor.id);
  }
  const res = await fetch(`/api/history/sessions?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to load study sessions");
  return res.json();
}

/** Study sessions, newest first — same "Load more" shape as useHistoryMistakesQuery. */
export function useHistorySessionsQuery(userId: string | undefined, filters: HistorySessionsFilters) {
  return useInfiniteQuery({
    queryKey: historySessionsKeys.list(userId, filters),
    queryFn: ({ pageParam }) => fetchSessionsPage(filters, pageParam),
    initialPageParam: null as Cursor,
    getNextPageParam: (last): Cursor => {
      if (!last.hasMore || last.items.length === 0) return null;
      const tail = last.items[last.items.length - 1];
      return { startedAt: tail.startedAt, id: tail.studySessionId };
    },
    enabled: !!userId,
    placeholderData: keepPreviousData,
  });
}
