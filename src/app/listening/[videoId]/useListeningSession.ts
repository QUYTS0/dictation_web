import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { YouTubePlayerHandle } from "@/components/YouTubePlayer";
import { usePlayerStore } from "@/store/playerStore";
import { findSegmentIndexAtTime } from "@/lib/utils/segment";
import {
  fetchListeningResumeSession,
  fetchTranscript,
  fetchTranslation,
  saveListeningProgress,
  triggerTranscriptGeneration,
} from "./api";
import type { ListeningSegment, TranscriptLoadState } from "./types";

interface UseListeningSessionOptions {
  videoId: string;
  user: User | null;
}

/**
 * Drives the listening-practice page: loads (or triggers generation of) the
 * English transcript, fetches its Vietnamese translation, combines the two
 * into per-segment EN+VI pairs, and tracks which segment is currently
 * playing so the subtitle overlay / transcript panel can highlight it.
 * Also autosaves/resumes watch position (in listening_sessions — separate
 * from dictation's learning_sessions, since there's no grading here) so
 * listening sessions show up in History/Dashboard like dictation ones do.
 *
 * Unlike dictation mode, playback here is continuous — the video is never
 * auto-paused per segment (the YouTubePlayer instance is given an empty
 * `segments` array on this page specifically so its built-in per-segment
 * auto-pause tick never fires).
 */
export function useListeningSession({ videoId, user }: UseListeningSessionOptions) {
  const [transcriptId, setTranscriptId] = useState<string | undefined>();
  const [showScript, setShowScript] = useState(true);
  const [showTranslation, setShowTranslation] = useState(true);
  const [resumeState, setResumeState] = useState<{ sessionId: string; videoCurrentTimeSec: number } | null>(null);

  const ytPlayerRef = useRef<YouTubePlayerHandle>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const transcriptIdRef = useRef<string | undefined>(undefined);
  const resumeLoadedRef = useRef(false);
  // Guards the visibilitychange/pagehide autosave below — merely opening a
  // video and switching tabs shouldn't spawn a fresh "active" session, only
  // actually having started/resumed playback should.
  const hasStartedRef = useRef(false);

  const setPlayerSegments = usePlayerStore((s) => s.setSegments);
  const currentTimeSec = usePlayerStore((s) => s.currentTimeSec);
  const playerStatus = usePlayerStore((s) => s.status);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTranscriptId(undefined);
    sessionIdRef.current = undefined;
    resumeLoadedRef.current = false;
    hasStartedRef.current = false;
    setResumeState(null);
  }, [videoId]);

  useEffect(() => {
    transcriptIdRef.current = transcriptId;
  }, [transcriptId]);

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

  // ---- Load a resumable session for authenticated users ----
  useEffect(() => {
    if (!user || transcriptStatus !== "ready" || resumeLoadedRef.current) return;
    resumeLoadedRef.current = true;
    fetchListeningResumeSession(videoId)
      .then((data) => {
        if (data.session && data.session.status === "active") {
          setResumeState({ sessionId: data.session.sessionId, videoCurrentTimeSec: data.session.videoCurrentTimeSec });
          sessionIdRef.current = data.session.sessionId;
        }
      })
      .catch(() => {});
  }, [transcriptStatus, user, videoId]);

  const triggerAutoSave = useCallback(
    (status: "active" | "completed" | "abandoned" = "active") => {
      if (!user) return;
      const timeSec = usePlayerStore.getState().currentTimeSec;
      void saveListeningProgress(videoId, timeSec, sessionIdRef.current, transcriptIdRef.current, status)
        .then((r) => {
          sessionIdRef.current = r.sessionId;
        })
        .catch(() => {});
    },
    [user, videoId]
  );

  const handleSeekToSegment = useCallback((segment: ListeningSegment) => {
    ytPlayerRef.current?.seekTo(segment.start, true);
  }, []);

  const handleStart = useCallback(() => {
    hasStartedRef.current = true;
    ytPlayerRef.current?.seekTo(0, true);
    triggerAutoSave("active");
  }, [triggerAutoSave]);

  const handleResume = useCallback(() => {
    hasStartedRef.current = true;
    ytPlayerRef.current?.seekTo(resumeState?.videoCurrentTimeSec ?? 0, true);
    triggerAutoSave("active");
  }, [resumeState, triggerAutoSave]);

  // Required by YouTubePlayer's prop signature, but never invoked in this
  // mode since it's only given real segments when auto-pause is wanted.
  const handleSegmentEnd = useCallback(() => {}, []);

  // ---- Mark completed when playback reaches the end of the video ----
  useEffect(() => {
    if (playerStatus === "ended" && hasStartedRef.current) {
      triggerAutoSave("completed");
    }
  }, [playerStatus, triggerAutoSave]);

  // ---- Periodic autosave while actively playing (no per-segment checkpoint
  // to hang saves off of, unlike dictation, since playback is continuous) ----
  useEffect(() => {
    if (playerStatus !== "playing" || !user) return;
    const interval = window.setInterval(() => triggerAutoSave("active"), 15_000);
    return () => window.clearInterval(interval);
  }, [playerStatus, user, triggerAutoSave]);

  // ---- Autosave when tab is hidden / page is being closed ----
  useEffect(() => {
    if (!user) return;
    const persist = () => {
      if (!hasStartedRef.current) return;
      triggerAutoSave("active");
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") persist();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", persist);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", persist);
    };
  }, [user, triggerAutoSave]);

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
    handleResume,
    handleSegmentEnd,
    resumeAvailable: resumeState !== null,
    resumeTimeSec: resumeState?.videoCurrentTimeSec ?? 0,
  };
}
