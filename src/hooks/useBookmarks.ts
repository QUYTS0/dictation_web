import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { Bookmark } from "@/lib/types";

/**
 * Shared bookmark plumbing for a single video, used by both the dictation
 * and listening pages (unlike vocabulary capture, which is dictation-only).
 */
export function useBookmarks(videoId: string, user: User | null) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRetry, setErrorRetry] = useState<(() => void) | null>(null);
  const fetchBookmarksRef = useRef<() => void>(() => {});

  const fetchBookmarks = useCallback(() => {
    let isCancelled = false;
    setLoading(true);
    setError(null);
    setErrorRetry(null);

    void fetch(`/api/bookmarks?videoId=${encodeURIComponent(videoId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch bookmarks");
        const data = (await res.json()) as { items?: Bookmark[] };
        if (isCancelled) return;
        setBookmarks(data.items ?? []);
      })
      .catch((err: unknown) => {
        if (isCancelled) return;
        const message =
          err instanceof Error && err.message ? err.message : "Failed to load bookmarks.";
        setError(message);
        setErrorRetry(() => () => fetchBookmarksRef.current());
      })
      .finally(() => {
        if (!isCancelled) setLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [videoId]);

  useEffect(() => {
    fetchBookmarksRef.current = fetchBookmarks;
  }, [fetchBookmarks]);

  useEffect(() => {
    if (!user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBookmarks([]);
      return;
    }
    return fetchBookmarks();
  }, [user, videoId, fetchBookmarks]);

  const bookmarkedSegmentIndexes = useMemo(
    () => new Set(bookmarks.map((b) => b.segment_index)),
    [bookmarks]
  );

  const toggleBookmark = useCallback(
    async (segmentIndex: number, startSec: number, sentenceText: string, note?: string) => {
      const existing = bookmarks.find((b) => b.segment_index === segmentIndex);
      if (existing) {
        const res = await fetch(`/api/bookmarks?id=${encodeURIComponent(existing.id)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error("Failed to remove bookmark");
        setBookmarks((prev) => prev.filter((b) => b.id !== existing.id));
        return;
      }

      const res = await fetch("/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, segmentIndex, startSec, sentenceText, note }),
      });
      if (!res.ok) throw new Error("Failed to save bookmark");
      const data = (await res.json()) as { item: Bookmark };
      setBookmarks((prev) => [data.item, ...prev.filter((b) => b.id !== data.item.id)]);
    },
    [bookmarks, videoId]
  );

  const deleteBookmark = useCallback(async (id: string) => {
    const res = await fetch(`/api/bookmarks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to remove bookmark");
    setBookmarks((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const updateBookmarkNote = useCallback(async (id: string, note: string) => {
    const res = await fetch("/api/bookmarks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, note }),
    });
    if (!res.ok) throw new Error("Failed to update bookmark");
    const data = (await res.json()) as { item: Bookmark };
    setBookmarks((prev) => prev.map((b) => (b.id === id ? data.item : b)));
  }, []);

  return {
    bookmarks,
    bookmarkedSegmentIndexes,
    loading,
    error,
    errorRetry,
    toggleBookmark,
    deleteBookmark,
    updateBookmarkNote,
  };
}
