import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTranslation } from "./api";

interface UseScriptTranslationOptions {
  videoId: string;
  transcriptId?: string;
  /** Only fetch while the caller actually needs translations (e.g. the Script tab is open). */
  enabled: boolean;
}

/**
 * Vietnamese translation for the Script tab's transcript lines — the same
 * cached endpoint the Listening mode uses, so a video translated there is
 * already free to show here. Fetched lazily (only while `enabled`) since
 * it's a secondary view, not the primary dictation flow.
 */
export function useScriptTranslation({ videoId, transcriptId, enabled }: UseScriptTranslationOptions) {
  const [showTranslation, setShowTranslation] = useState(false);

  const translationQuery = useQuery({
    queryKey: ["dictation-script-translation", transcriptId],
    queryFn: () => fetchTranslation(videoId, transcriptId as string, "vi"),
    enabled: enabled && showTranslation && !!transcriptId,
    retry: false,
    staleTime: Infinity,
  });

  const translationBySegmentIndex = useMemo(
    () => new Map((translationQuery.data?.translations ?? []).map((t) => [t.segmentIndex, t.textTranslated])),
    [translationQuery.data]
  );

  return {
    showTranslation,
    setShowTranslation,
    translationBySegmentIndex,
    translationLoading: translationQuery.isFetching,
    translationError: translationQuery.isError,
  };
}
