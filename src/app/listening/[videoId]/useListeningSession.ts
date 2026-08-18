import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { YouTubePlayerHandle } from "@/components/YouTubePlayer";
import { usePlayerStore } from "@/store/playerStore";
import { findSegmentIndexAtTime } from "@/lib/utils/segment";
import { fetchTranscript, fetchTranslation, triggerTranscriptGeneration } from "./api";
import type { ListeningSegment, TranscriptLoadState } from "./types";

interface UseListeningSessionOptions {
  videoId: string;
}

/**
 * Drives the listening-practice page: loads (or triggers generation of) the
 * English transcript, fetches its Vietnamese translation, combines the two
 * into per-segment EN+VI pairs, and tracks which segment is currently
 * playing so the subtitle overlay / transcript panel can highlight it.
 *
 * Unlike dictation mode, playback here is continuous — the video is never
 * auto-paused per segment (the YouTubePlayer instance is given an empty
 * `segments` array on this page specifically so its built-in per-segment
 * auto-pause tick never fires).
 */
export function useListeningSession({ videoId }: UseListeningSessionOptions) {
  const [transcriptId, setTranscriptId] = useState<string | undefined>();
  const [showScript, setShowScript] = useState(true);
  const [showTranslation, setShowTranslation] = useState(true);

  const ytPlayerRef = useRef<YouTubePlayerHandle>(null);

  const setPlayerSegments = usePlayerStore((s) => s.setSegments);
  const currentTimeSec = usePlayerStore((s) => s.currentTimeSec);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTranscriptId(undefined);
  }, [videoId]);

  // ---- English transcript (reuses the same generate/read endpoints as dictation) ----
  const transcriptQuery = useQuery({
    queryKey: ["listening-transcript", videoId],
    queryFn: () => fetchTranscript(videoId),
    refetchInterval: (query) => (query.state.data?.status === "processing" ? 3000 : false),
    enabled: !!videoId,
  });

  const segments = useMemo(() => transcriptQuery.data?.segments ?? [], [transcriptQuery.data?.segments]);
  const transcriptStatus = transcriptQuery.data?.status;

  useEffect(() => {
    // The listening page never passes real segments to YouTubePlayer (playback
    // is continuous), but other consumers of the player store still expect it.
    setPlayerSegments(segments);
  }, [segments, setPlayerSegments]);

  useEffect(() => {
    if (transcriptStatus === "processing" && !transcriptId) {
      void triggerTranscriptGeneration(videoId).then((d) => {
        if (d.transcriptId) setTranscriptId(d.transcriptId);
      });
    }
  }, [transcriptStatus, transcriptId, videoId]);

  useEffect(() => {
    if (segments.length > 0 && segments[0].transcript_id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTranscriptId(segments[0].transcript_id);
    }
  }, [segments]);

  // ---- Vietnamese translation ----
  const translationQuery = useQuery({
    queryKey: ["listening-translation", transcriptId],
    queryFn: () => fetchTranslation(videoId, transcriptId as string, "vi"),
    enabled: !!transcriptId && transcriptStatus === "ready" && segments.length > 0,
    retry: false,
    staleTime: Infinity,
  });

  const combinedSegments: ListeningSegment[] = useMemo(() => {
    const translationBySegment = new Map(
      (translationQuery.data?.translations ?? []).map((t) => [t.segmentIndex, t.textTranslated])
    );
    return segments.map((s) => ({
      segmentIndex: s.segmentIndex,
      start: s.start,
      end: s.end,
      textEn: s.text,
      textVi: translationBySegment.get(s.segmentIndex) ?? null,
    }));
  }, [segments, translationQuery.data]);

  const loadState: TranscriptLoadState =
    transcriptQuery.isLoading || transcriptStatus === undefined
      ? "loading"
      : transcriptStatus === "processing"
        ? "processing"
        : transcriptStatus === "failed" || (transcriptStatus === "ready" && segments.length === 0)
          ? "failed"
          : "ready";

  const activeSegmentIndex = useMemo(
    () => findSegmentIndexAtTime(combinedSegments, currentTimeSec),
    [combinedSegments, currentTimeSec]
  );

  const handleSeekToSegment = useCallback((segment: ListeningSegment) => {
    ytPlayerRef.current?.seekTo(segment.start, true);
  }, []);

  const handleStart = useCallback(() => {
    ytPlayerRef.current?.seekTo(0, true);
  }, []);

  // Required by YouTubePlayer's prop signature, but never invoked in this
  // mode since it's only given real segments when auto-pause is wanted.
  const handleSegmentEnd = useCallback(() => {}, []);

  return {
    loadState,
    transcriptTitle: transcriptQuery.data?.title,
    segments: combinedSegments,
    activeSegmentIndex,
    showScript,
    setShowScript,
    showTranslation,
    setShowTranslation,
    translationLoading: translationQuery.isFetching,
    translationError: translationQuery.isError,
    hasTranslations: combinedSegments.some((s) => s.textVi !== null),
    refetchTranscript: transcriptQuery.refetch,
    refetchTranslation: translationQuery.refetch,
    ytPlayerRef,
    handleSeekToSegment,
    handleStart,
    handleSegmentEnd,
  };
}
