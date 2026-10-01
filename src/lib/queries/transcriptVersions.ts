"use client";

import { useQuery } from "@tanstack/react-query";
import type { TranscriptVersionPreview, TranscriptVersionsResponse } from "@/lib/types/learning";

export const transcriptVersionsKeys = {
  /** User-scoped: the listing carries the viewer's OWN round association. */
  list: (userId: string | undefined, videoId: string) => ["transcript-versions", userId, videoId] as const,
  /** A published revision's text never changes — shared and immutable. */
  preview: (videoId: string, transcriptId: string | null) => ["transcript-version-preview", videoId, transcriptId] as const,
};

async function getJson<T>(url: string, failure: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(failure) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** The Script Versions listing — refetched every time the dialog opens
 *  (staleTime 0), so a revision published meanwhile always shows up. */
export function useTranscriptVersionsQuery(userId: string | undefined, videoId: string, enabled: boolean) {
  return useQuery({
    queryKey: transcriptVersionsKeys.list(userId, videoId),
    queryFn: () =>
      getJson<TranscriptVersionsResponse>(`/api/transcripts/${encodeURIComponent(videoId)}/versions`, "Couldn't load script versions."),
    enabled: enabled && !!userId,
    staleTime: 0,
  });
}

/** Read-only preview of one revision's sentences. */
export function useTranscriptVersionPreviewQuery(videoId: string, transcriptId: string | null) {
  return useQuery({
    queryKey: transcriptVersionsKeys.preview(videoId, transcriptId),
    queryFn: () =>
      getJson<TranscriptVersionPreview>(
        `/api/transcripts/${encodeURIComponent(videoId)}/versions/${encodeURIComponent(transcriptId as string)}/preview`,
        "Couldn't load this script version."
      ),
    enabled: !!transcriptId,
    staleTime: Infinity,
  });
}
