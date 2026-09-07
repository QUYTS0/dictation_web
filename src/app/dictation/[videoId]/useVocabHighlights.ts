import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchVocabHighlights } from "./api";
import { DEFAULT_LEARNING_LEVEL } from "@/lib/vocabHighlights/publicConfig";

interface UseVocabHighlightsOptions {
  videoId: string;
  transcriptId?: string;
  /** Only fetch while the caller actually needs highlights (e.g. the Script tab is open). */
  enabled: boolean;
}

const QUERY_KEY_PREFIX = "dictation-vocab-highlights";

/** Bounded follow-up attempts when the server reports `incomplete: true`
 *  (some segments couldn't be resolved yet) — a fixed retry budget, not an
 *  infinite polling loop. Each follow-up naturally only recomputes
 *  still-missing segments server-side (the cache-read/`missing` split). */
const INCOMPLETE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

/**
 * Deterministic local-pipeline (winkNLP/EFLLex/SUBTLEX/WordNet, + optional
 * Azure enrichment) difficult words/phrases per transcript segment, for the
 * Script tab's underline highlighting. Cached server-side, versioned by
 * (transcript, segment, learning level, pipeline version) — see
 * src/lib/vocabHighlights/cache.ts.
 */
export function useVocabHighlights({ videoId, transcriptId, enabled }: UseVocabHighlightsOptions) {
  const learningLevel = DEFAULT_LEARNING_LEVEL;
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => [QUERY_KEY_PREFIX, transcriptId, learningLevel], [transcriptId, learningLevel]);

  const [regeneratingHighlights, setRegeneratingHighlights] = useState(false);
  const [regenerateHighlightsError, setRegenerateHighlightsError] = useState<string | null>(null);
  const regeneratingRef = useRef(false);
  const retryAttemptRef = useRef(0);
  const retryTimeoutRef = useRef<number | null>(null);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchVocabHighlights(videoId, transcriptId as string, learningLevel),
    enabled: enabled && !!transcriptId,
    retry: false,
    staleTime: (q) => (q.state.data?.incomplete ? 0 : Infinity),
  });

  useEffect(() => {
    if (!query.data?.incomplete) {
      retryAttemptRef.current = 0;
      return;
    }
    if (retryAttemptRef.current >= INCOMPLETE_RETRY_DELAYS_MS.length) return;

    const delay = INCOMPLETE_RETRY_DELAYS_MS[retryAttemptRef.current];
    retryAttemptRef.current += 1;
    retryTimeoutRef.current = window.setTimeout(() => {
      void query.refetch();
    }, delay);

    return () => {
      if (retryTimeoutRef.current) window.clearTimeout(retryTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-arm when the incomplete flag itself changes
  }, [query.data?.incomplete]);

  const phrasesBySegmentIndex = useMemo(
    () => new Map((query.data?.highlights ?? []).map((h) => [h.segmentIndex, h.phrases])),
    [query.data]
  );

  /** Fully separate from Regenerate Translation — different query key,
   *  different route call, no shared cache invalidation either direction. */
  const regenerateVocabHighlights = useCallback(async () => {
    if (!transcriptId || regeneratingRef.current) return;
    regeneratingRef.current = true;
    setRegeneratingHighlights(true);
    setRegenerateHighlightsError(null);
    try {
      const data = await fetchVocabHighlights(videoId, transcriptId, learningLevel, true);
      queryClient.setQueryData(queryKey, data);
    } catch (err) {
      setRegenerateHighlightsError(err instanceof Error ? err.message : "Failed to regenerate vocabulary highlights.");
    } finally {
      regeneratingRef.current = false;
      setRegeneratingHighlights(false);
    }
  }, [videoId, transcriptId, learningLevel, queryClient, queryKey]);

  return {
    phrasesBySegmentIndex,
    highlightsLoading: query.isFetching,
    highlightsError: query.isError,
    regenerateVocabHighlights,
    regeneratingHighlights,
    regenerateHighlightsError,
  };
}
