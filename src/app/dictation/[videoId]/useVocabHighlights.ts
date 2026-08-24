import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchVocabHighlights } from "./api";

interface UseVocabHighlightsOptions {
  videoId: string;
  transcriptId?: string;
  /** Only fetch while the caller actually needs highlights (e.g. the Script tab is open). */
  enabled: boolean;
}

/**
 * AI-picked difficult words/phrases per transcript segment, for the Script
 * tab's underline highlighting. Cached server-side per transcript (see
 * /api/transcript/vocab-highlights), so this costs the shared Gemini quota
 * at most once per video, ever — fetched lazily here too, only while the
 * Script tab is actually open.
 */
export function useVocabHighlights({ videoId, transcriptId, enabled }: UseVocabHighlightsOptions) {
  const query = useQuery({
    queryKey: ["dictation-vocab-highlights", transcriptId],
    queryFn: () => fetchVocabHighlights(videoId, transcriptId as string),
    enabled: enabled && !!transcriptId,
    retry: false,
    staleTime: Infinity,
  });

  const phrasesBySegmentIndex = useMemo(
    () => new Map((query.data?.highlights ?? []).map((h) => [h.segmentIndex, h.phrases])),
    [query.data]
  );

  return {
    phrasesBySegmentIndex,
    highlightsLoading: query.isFetching,
    highlightsError: query.isError,
  };
}
