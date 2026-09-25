"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Bookmark } from "@/lib/types";

export interface BookmarkWithVideo extends Bookmark {
  videoTitle: string | null;
}

export const bookmarksKeys = {
  all: (userId: string | undefined) => ["bookmarks", userId] as const,
};

async function fetchBookmarks(): Promise<BookmarkWithVideo[]> {
  const res = await fetch("/api/bookmarks");
  if (!res.ok) throw new Error("Failed to fetch bookmarks");
  const data = (await res.json()) as { items?: BookmarkWithVideo[] };
  return data.items ?? [];
}

export function useBookmarksQuery(userId: string | undefined) {
  return useQuery({
    queryKey: bookmarksKeys.all(userId),
    queryFn: fetchBookmarks,
    enabled: !!userId,
  });
}

/** Call after a bookmark is added/removed/edited from *outside* the
 *  Bookmarks page itself (the per-video bookmark toggle on the dictation/
 *  listening pages, via useBookmarks.ts), so the Bookmarks page's cache
 *  catches up on next visit. */
export function invalidateBookmarksQuery(queryClient: QueryClient, userId: string | undefined) {
  void queryClient.invalidateQueries({ queryKey: bookmarksKeys.all(userId) });
}

export function useDeleteBookmarkMutation(userId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const res = await fetch(`/api/bookmarks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to delete bookmark.");
      }
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData<BookmarkWithVideo[]>(bookmarksKeys.all(userId), (old) =>
        old?.filter((item) => item.id !== id)
      );
    },
  });
}

export function useUpdateBookmarkNoteMutation(userId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, note }: { id: string; note: string }): Promise<Bookmark> => {
      const res = await fetch("/api/bookmarks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, note }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; item?: Bookmark };
      if (!res.ok || !data.item) {
        throw new Error(data.error || "Failed to update bookmark.");
      }
      return data.item;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<BookmarkWithVideo[]>(bookmarksKeys.all(userId), (old) =>
        old?.map((item) => (item.id === updated.id ? { ...item, note: updated.note } : item))
      );
    },
  });
}
