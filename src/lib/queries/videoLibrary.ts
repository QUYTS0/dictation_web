"use client";

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { LibraryFilter, LibraryPage } from "@/lib/types/learning";

export const LIBRARY_PAGE_SIZE = 12;
/** The Dashboard resumes ONE item — the same top item Focus evaluates. */
export const CONTINUE_LEARNING_LIMIT = 1;

export const videoLibraryKeys = {
  /** Prefix covering every Library query of this user (list pages, Continue Learning). */
  allForUser: (userId: string | undefined) => ["video-library", userId] as const,
  list: (userId: string | undefined, filter: LibraryFilter) => ["video-library", userId, "list", filter] as const,
  continueLearning: (userId: string | undefined) => ["video-library", userId, "continue"] as const,
};

export async function fetchLibraryPage(filter: LibraryFilter, offset: number, limit = LIBRARY_PAGE_SIZE): Promise<LibraryPage> {
  const params = new URLSearchParams({ filter, offset: String(offset), limit: String(limit) });
  const res = await fetch(`/api/videos/library?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to load your library");
  return res.json();
}

/** The Library, one card per video, "Load more" pagination (deterministic order). */
export function useVideoLibraryQuery(userId: string | undefined, filter: LibraryFilter) {
  return useInfiniteQuery({
    queryKey: videoLibraryKeys.list(userId, filter),
    queryFn: ({ pageParam }) => fetchLibraryPage(filter, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.offset + last.items.length : undefined),
    enabled: !!userId,
    // A filter change keeps the previous cards on screen until the new ones arrive.
    placeholderData: keepPreviousData,
  });
}

/** Unfinished work (an active round with practice, or Listening in progress), most recent first. */
export function useContinueLearningQuery(userId: string | undefined) {
  return useQuery({
    queryKey: videoLibraryKeys.continueLearning(userId),
    queryFn: () => fetchLibraryPage("continue", 0, CONTINUE_LEARNING_LIMIT),
    enabled: !!userId,
  });
}

export async function removeFromLibrary(videoId: string): Promise<{ removed: boolean }> {
  const res = await fetch(`/api/videos/library/${encodeURIComponent(videoId)}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Couldn't remove this video from your library");
  return res.json();
}

/** Records an explicit mode switch as the video's last mode (fire-and-forget safe). */
export async function persistLastMode(videoId: string, mode: "dictation" | "listening" | "shadowing"): Promise<boolean> {
  try {
    const res = await fetch(`/api/videos/${encodeURIComponent(videoId)}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
