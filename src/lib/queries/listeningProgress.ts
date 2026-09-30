import { useQuery } from "@tanstack/react-query";
import type { ListeningProgressResponse } from "@/lib/practice/listeningTypes";

export const listeningProgressKeys = {
  /** Scoped by revision — a regenerated script never shows the old one's coverage. */
  progress: (userId: string | undefined, videoId: string, transcriptId: string | null) =>
    ["listening-progress", userId, videoId, transcriptId ?? null] as const,
};

async function fetchListeningProgress(videoId: string, transcriptId: string | null): Promise<ListeningProgressResponse> {
  const params = new URLSearchParams({ videoId });
  if (transcriptId) params.set("transcriptId", transcriptId);
  const res = await fetch(`/api/listening/progress?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to load listening progress");
  return res.json();
}

/** The signed-in user's Listening coverage for one video revision. Patched
 *  in place after every successful sync (practiceFlushCoordinator). */
export function useListeningProgressQuery(userId: string | undefined, videoId: string, transcriptId: string | null, enabled = true) {
  return useQuery({
    queryKey: listeningProgressKeys.progress(userId, videoId, transcriptId),
    queryFn: () => fetchListeningProgress(videoId, transcriptId),
    enabled: enabled && !!userId && !!videoId,
  });
}
