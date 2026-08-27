import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchTranslation } from "./api";

interface UseScriptTranslationOptions {
  videoId: string;
  transcriptId?: string;
  /** Only fetch while the caller actually needs translations (e.g. the Script tab is open). */
  enabled: boolean;
  /** Fetch even if the Script tab's own "Show translation" toggle is off — e.g. the
   * Default layout's inline translation line under the input, gated by subtitle visibility. */
  wantTranslation?: boolean;
}

const TRANSLATION_QUERY_KEY_PREFIX = "dictation-script-translation";

/**
 * Vietnamese translation for the Script tab's transcript lines — the same
 * cached endpoint the Listening mode uses, so a video translated there is
 * already free to show here. Fetched lazily (only while `enabled`) since
 * it's a secondary view, not the primary dictation flow.
 */
export function useScriptTranslation({
  videoId,
  transcriptId,
  enabled,
  wantTranslation = false,
}: UseScriptTranslationOptions) {
  const [showTranslation, setShowTranslation] = useState(false);
  const [regeneratingTranslation, setRegeneratingTranslation] = useState(false);
  const [regenerateTranslationError, setRegenerateTranslationError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const translationQuery = useQuery({
    queryKey: [TRANSLATION_QUERY_KEY_PREFIX, transcriptId],
    queryFn: () => fetchTranslation(videoId, transcriptId as string, "vi"),
    enabled: enabled && (showTranslation || wantTranslation) && !!transcriptId,
    retry: false,
    staleTime: Infinity,
  });

  const translationBySegmentIndex = useMemo(
    () => new Map((translationQuery.data?.translations ?? []).map((t) => [t.segmentIndex, t.textTranslated])),
    [translationQuery.data]
  );

  // Separate from dictation's "Regenerate script" (transcript) action — this
  // only re-derives the Vietnamese text for the already-correct English
  // script, bypassing the server-side cache so stale/misaligned translations
  // get recomputed. Own loading/error state (not shared with transcript
  // regeneration) so the two actions can't be confused with each other.
  const regenerateTranslation = useCallback(async () => {
    if (!transcriptId || regeneratingTranslation) return;
    setRegeneratingTranslation(true);
    setRegenerateTranslationError(null);
    try {
      const data = await fetchTranslation(videoId, transcriptId, "vi", true);
      queryClient.setQueryData([TRANSLATION_QUERY_KEY_PREFIX, transcriptId], data);
    } catch (err) {
      setRegenerateTranslationError(
        err instanceof Error ? err.message : "Failed to regenerate translation."
      );
    } finally {
      setRegeneratingTranslation(false);
    }
  }, [videoId, transcriptId, regeneratingTranslation, queryClient]);

  return {
    showTranslation,
    setShowTranslation,
    translationBySegmentIndex,
    translationLoading: translationQuery.isFetching,
    translationError: translationQuery.isError,
    regenerateTranslation,
    regeneratingTranslation,
    regenerateTranslationError,
  };
}
