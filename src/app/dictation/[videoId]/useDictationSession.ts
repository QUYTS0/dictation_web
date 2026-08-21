import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { YouTubePlayerHandle } from "@/components/YouTubePlayer";
import { usePlayerStore } from "@/store/playerStore";
import { useSessionStore, selectAccuracy } from "@/store/sessionStore";
import { checkAnswer as evaluateAnswer } from "@/lib/utils/text";
import type { TranscriptSegment, CheckAnswerResponse, HintLevel, UXState } from "@/lib/types";
import { RESUME_SEEK_DELAY_MS, CORRECT_RESULT_VISIBILITY_DELAY_MS } from "./constants";
import {
  fetchTranscript,
  checkAnswerApi,
  saveProgress,
  fetchResumeSession,
  restartSession,
  regenerateTranscript,
} from "./api";
import type { MistakeRecord, CompletedSentenceReview, ResumeState } from "./types";

interface UseDictationSessionOptions {
  videoId: string;
  user: User | null;
}

/**
 * The core dictation session state machine: loads/generates the transcript,
 * plays each segment, checks answers, tracks mistakes, autosaves progress,
 * and resumes/restarts sessions. This is the single most stateful part of
 * the dictation page — kept as one cohesive hook rather than split further,
 * since its pieces (segment index, playback, answer checking, autosave) are
 * all facets of the same session, not separable concerns.
 */
export function useDictationSession({ videoId, user }: UseDictationSessionOptions) {
  const playerStore = usePlayerStore();
  const sessionStore = useSessionStore();

  const [currentSegIdx, setCurrentSegIdx] = useState(0);
  const [uxState, setUxState] = useState<UXState>("loading_transcript");
  const [checkResult, setCheckResult] = useState<CheckAnswerResponse | null>(null);
  const [wrongAttempts, setWrongAttempts] = useState(0);
  const [hintLevel, setHintLevel] = useState<HintLevel>(0);
  const [transcriptId, setTranscriptId] = useState<string | undefined>();
  // In-memory mistake tracking for the session-review panel at completion
  const [mistakes, setMistakes] = useState<MistakeRecord[]>([]);
  const [resumeState, setResumeState] = useState<ResumeState | null>(null);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [previousReview, setPreviousReview] = useState<CompletedSentenceReview | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [checkAnswerError, setCheckAnswerError] = useState<string | null>(null);
  // Consecutive "clean" solves (correct on the first try, no hint used). Resets on any wrong submit.
  const [combo, setCombo] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [cleanSolveCount, setCleanSolveCount] = useState(0);
  const [isLastResultClean, setIsLastResultClean] = useState(false);
  // Snapshot of the user's last *completed* run on this video, captured before this
  // visit's autosave can overwrite that row — used for the "vs last run" recap comparison.
  const [previousRunSnapshot, setPreviousRunSnapshot] = useState<{ accuracy: number; totalAttempts: number } | null>(
    null
  );

  const ytPlayerRef = useRef<YouTubePlayerHandle>(null);
  // Tracks whether the user manually triggered a replay while already paused
  // (keyboard shortcut / Replay button while input is visible). In this case we keep the
  // input and its typed words intact when the segment ends.
  const isManualReplayWhilePaused = useRef(false);
  // Ref mirror of currentSegIdx — lets handleSegmentEnd guard against stale
  // callbacks that fire after the user has already submitted early and advanced.
  const currentSegIdxRef = useRef(0);
  // Mirror of uxState — lets the visibility/pagehide autosave below check
  // "has the user actually started practicing" without re-registering its
  // listeners on every state change.
  const uxStateRef = useRef<UXState>("loading_transcript");
  const resumeLoadedRef = useRef(false);
  const firstAttemptBySegmentRef = useRef<Record<number, string>>({});

  useEffect(() => {
    resumeLoadedRef.current = false;
    setResumeState(null);
    firstAttemptBySegmentRef.current = {};
    // The session store (sessionId, attempt/correct counts) is global and
    // persisted, so it must be wiped whenever the active video changes —
    // otherwise the accuracy shown for this video is actually the running
    // accuracy carried over from whatever video was practiced previously,
    // and a stale sessionId could get reused to save progress against the
    // wrong video's session row.
    useSessionStore.getState().reset();
  }, [videoId, user?.id]);

  // ---- Transcript query ----
  const transcriptQuery = useQuery({
    queryKey: ["transcript", videoId],
    queryFn: () => fetchTranscript(videoId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "processing" ? 3000 : false;
    },
    enabled: !!videoId,
  });

  const segments: TranscriptSegment[] = useMemo(
    () => transcriptQuery.data?.segments ?? [],
    [transcriptQuery.data?.segments]
  );
  const transcriptStatus = transcriptQuery.data?.status;

  // Sync segments into player store
  useEffect(() => {
    playerStore.setSegments(segments);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments]);

  // Update UX state based on transcript status
  useEffect(() => {
    if (transcriptQuery.isLoading) {
      setUxState("loading_transcript");
    } else if (transcriptStatus === "processing") {
      setUxState("transcript_processing");
    } else if (transcriptStatus === "failed") {
      setUxState("transcript_failed");
    } else if (transcriptStatus === "ready" && segments.length > 0) {
      setUxState("transcript_ready");
    } else if (transcriptStatus === "ready" && segments.length === 0) {
      // Transcript marked ready but no segments — treat as failed so user gets feedback
      setUxState("transcript_failed");
    }
  }, [transcriptStatus, transcriptQuery.isLoading, segments.length]);

  useEffect(() => {
    uxStateRef.current = uxState;
  }, [uxState]);

  // ---- Segment end handler (called by YouTubePlayer) ----
  const handleSegmentEnd = useCallback((segIdx: number) => {
    // Guard: if the user already submitted early and advanced past this segment,
    // ignore the stale callback from the player's time-polling tick.
    if (segIdx < currentSegIdxRef.current) return;

    // Manual replay triggered while input was already visible — keep everything
    // intact so the user's typed words are preserved.
    if (isManualReplayWhilePaused.current) {
      isManualReplayWhilePaused.current = false;
      return;
    }

    // Normal flow: segment ended while practicing — show the dictation input.
    setCurrentSegIdx(segIdx);
    currentSegIdxRef.current = segIdx;
    setCheckResult(null);
    setWrongAttempts(0);
    setHintLevel(0);
    setUxState("paused_waiting_input");
  }, []);

  const triggerAutoSave = useCallback(
    (segmentIndex: number, status: "active" | "completed" | "abandoned" = "active") => {
      if (!user) return;
      const state = useSessionStore.getState();
      void saveProgress(
        videoId,
        segmentIndex,
        playerStore.currentTimeSec,
        selectAccuracy(state),
        state.totalAttempts,
        state.sessionId ?? undefined,
        transcriptId,
        status
      )
        .then((r) => {
          if (!state.sessionId) sessionStore.setSessionId(r.sessionId);
        })
        .catch(() => {
          if (state.sessionId) sessionStore.setSessionId(null);
        });
    },
    [playerStore.currentTimeSec, sessionStore, transcriptId, user, videoId]
  );

  // ---- Answer submission ----
  const handleAnswerSubmit = useCallback(
    async (userText: string) => {
      if (!segments[currentSegIdx]) return;
      if (firstAttemptBySegmentRef.current[currentSegIdx] === undefined) {
        firstAttemptBySegmentRef.current[currentSegIdx] = userText;
      }
      setUxState("checking_answer");
      setCheckAnswerError(null);

      try {
        const result = await checkAnswerApi(
          currentSegIdx,
          userText,
          segments[currentSegIdx].text,
          "relaxed",
          sessionStore.sessionId ?? undefined
        );

        setCheckResult(result);
        sessionStore.incrementAttempt(result.isCorrect);

        if (result.isCorrect) {
          const isClean = wrongAttempts === 0 && hintLevel === 0;
          setIsLastResultClean(isClean);
          if (isClean) {
            setCleanSolveCount((c) => c + 1);
            const nextCombo = combo + 1;
            setCombo(nextCombo);
            setBestCombo((best) => Math.max(best, nextCombo));
          }

          const firstAttemptText = (firstAttemptBySegmentRef.current[currentSegIdx] ?? userText).trim();
          const firstAttemptReview = evaluateAnswer(
            segments[currentSegIdx].text,
            firstAttemptText,
            result.matchMode
          );
          setPreviousReview({
            segmentIndex: currentSegIdx,
            expectedText: segments[currentSegIdx].text,
            firstUserText: firstAttemptText,
            diff: firstAttemptReview.diff ?? [],
          });
          setWrongAttempts(0);
          setHintLevel(0);

          const nextIdx = currentSegIdx + 1;
          triggerAutoSave(nextIdx, "active");
          window.setTimeout(() => {
            setCheckResult(null);
            if (nextIdx < segments.length) {
              currentSegIdxRef.current = nextIdx;
              setCurrentSegIdx(nextIdx);
              setUxState("playing");
              ytPlayerRef.current?.playSegment(nextIdx);
            } else {
              setUxState("session_completed");
              triggerAutoSave(nextIdx, "completed");
            }
          }, CORRECT_RESULT_VISIBILITY_DELAY_MS);
        } else {
          const newWrong = wrongAttempts + 1;
          setWrongAttempts(newWrong);
          setCombo(0);
          setIsLastResultClean(false);
          // Record first mistake for this segment (deduplicated by segIdx)
          const segText = segments[currentSegIdx].text;
          setMistakes((prev) =>
            prev.some((m) => m.segIdx === currentSegIdx)
              ? prev
              : [
                  ...prev,
                  {
                    segIdx: currentSegIdx,
                    expectedText: segText,
                    userText: result.normalizedUser || userText,
                    diff: result.diff ?? [],
                  },
                ]
          );
          // Pause video when the user submits incorrectly during playback
          ytPlayerRef.current?.pauseVideo();
          setUxState("paused_waiting_input");
        }
      } catch (err) {
        setCheckAnswerError(err instanceof Error ? err.message : "Failed to check your answer.");
        setUxState("paused_waiting_input");
      }
    },
    [currentSegIdx, segments, sessionStore, triggerAutoSave, wrongAttempts, hintLevel, combo]
  );

  // ---- Start session (seek to segment 0 and play) ----
  const handleStart = useCallback(() => {
    firstAttemptBySegmentRef.current = {};
    triggerAutoSave(0, "active");
    setUxState("playing");
    ytPlayerRef.current?.playSegment(0);
  }, [triggerAutoSave]);

  // ---- Replay current segment ----
  const handleReplay = useCallback(() => {
    // If the input is already visible, mark this as a "paused replay" so the
    // segment-end handler won't reset the input or typed words.
    const isAlreadyPaused = uxState === "paused_waiting_input";
    isManualReplayWhilePaused.current = isAlreadyPaused;
    if (!isAlreadyPaused) {
      setUxState("playing");
      setCheckResult(null); // Clear stale check result when replaying from playing state
    }
    ytPlayerRef.current?.playSegment(currentSegIdx);
  }, [currentSegIdx, uxState]);

  // ---- Skip current segment ----
  const handleSkip = useCallback(() => {
    const nextIdx = currentSegIdx + 1;
    if (nextIdx < segments.length) {
      currentSegIdxRef.current = nextIdx;
      setCurrentSegIdx(nextIdx);
      ytPlayerRef.current?.playSegment(nextIdx);
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      setUxState("playing");
      triggerAutoSave(nextIdx, "active");
    }
  }, [currentSegIdx, segments.length, triggerAutoSave]);

  // ---- Go to previous segment ----
  const handlePrevious = useCallback(() => {
    const prevIdx = currentSegIdx - 1;
    if (prevIdx >= 0) {
      currentSegIdxRef.current = prevIdx;
      setCurrentSegIdx(prevIdx);
      ytPlayerRef.current?.playSegment(prevIdx);
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      setUxState("playing");
      triggerAutoSave(prevIdx, "active");
    }
  }, [currentSegIdx, triggerAutoSave]);

  // ---- Trigger transcript generation if not ready ----
  useEffect(() => {
    if (transcriptStatus === "processing" && !transcriptId) {
      fetch("/api/transcript/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.transcriptId) setTranscriptId(d.transcriptId);
        })
        .catch(() => {});
    }
  }, [transcriptStatus, transcriptId, videoId]);

  const handleManualTranscriptSaved = useCallback(
    async (id: string) => {
      setTranscriptId(id);
      await transcriptQuery.refetch();
    },
    [transcriptQuery]
  );

  // ---- Regenerate transcript from YouTube captions (discards the cached script) ----
  const handleRegenerateTranscript = useCallback(async () => {
    setRegenerating(true);
    setRegenerateError(null);
    ytPlayerRef.current?.pauseVideo();
    setUxState("transcript_processing");
    currentSegIdxRef.current = 0;
    setCurrentSegIdx(0);
    setCheckResult(null);
    setWrongAttempts(0);
    setHintLevel(0);
    setMistakes([]);
    setPreviousReview(null);
    setResumeState(null);
    setCombo(0);
    setBestCombo(0);
    setCleanSolveCount(0);
    setIsLastResultClean(false);
    firstAttemptBySegmentRef.current = {};

    try {
      const result = await regenerateTranscript(videoId);
      if (result.transcriptId) setTranscriptId(result.transcriptId);
    } catch (err) {
      setRegenerateError(err instanceof Error ? err.message : "Failed to regenerate transcript.");
    } finally {
      await transcriptQuery.refetch();
      setRegenerating(false);
    }
  }, [videoId, transcriptQuery]);

  // ---- Load resumable session for authenticated users ----
  useEffect(() => {
    if (!user || transcriptStatus !== "ready" || resumeLoadedRef.current) return;
    setResumeLoading(true);
    fetchResumeSession(videoId)
      .then((data) => {
        if (data.session) {
          // Only a fully completed prior run is a fair "vs last run" baseline —
          // an interrupted "active" session reflects partial progress, not a full attempt.
          if (data.session.status === "completed" && data.session.totalAttempts > 0) {
            setPreviousRunSnapshot({
              accuracy: data.session.accuracy,
              totalAttempts: data.session.totalAttempts,
            });
          }
          setResumeState({
            sessionId: data.session.sessionId,
            currentSegmentIndex: data.session.currentSegmentIndex,
            videoCurrentTimeSec: data.session.videoCurrentTimeSec,
            status: data.session.status,
            accuracy: data.session.accuracy,
            totalAttempts: data.session.totalAttempts,
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        resumeLoadedRef.current = true;
        setResumeLoading(false);
      });
  }, [transcriptStatus, user, videoId]);

  // ---- Autosave when tab is hidden / page is being closed ----
  useEffect(() => {
    if (!user) return;
    const persist = () => {
      // Only autosave if dictation practice actually started this visit —
      // otherwise merely opening a video and switching tabs/closing it
      // spawns a fresh "active" session at segment 0, which then shows up
      // as bogus in-progress state even for a video the user already
      // completed (or never touched).
      const practicingStates: UXState[] = ["playing", "paused_waiting_input", "checking_answer"];
      if (!practicingStates.includes(uxStateRef.current)) return;
      triggerAutoSave(currentSegIdxRef.current, "active");
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
  }, [triggerAutoSave, user]);

  const handleResume = useCallback(() => {
    if (!resumeState || segments.length === 0) return;
    const segIdx = Math.min(Math.max(resumeState.currentSegmentIndex, 0), segments.length - 1);
    sessionStore.setSessionId(resumeState.sessionId);
    // Restore this video's own accuracy tally so continued practice blends
    // with what was already recorded, instead of starting from the counts
    // left over from whatever the store last held.
    sessionStore.hydrateAccuracy(
      resumeState.totalAttempts,
      Math.round((resumeState.accuracy / 100) * resumeState.totalAttempts)
    );
    currentSegIdxRef.current = segIdx;
    setCurrentSegIdx(segIdx);
    setResumeState(null);
    setUxState("playing");
    ytPlayerRef.current?.playSegment(segIdx);
    const resumeTimeSec = resumeState.videoCurrentTimeSec;
    if (resumeTimeSec > 0) {
      window.setTimeout(() => {
        ytPlayerRef.current?.seekTo(resumeTimeSec, true);
      }, RESUME_SEEK_DELAY_MS);
    }
  }, [resumeState, segments.length, sessionStore]);

  // ---- Jump directly to an arbitrary segment (e.g. from a bookmark deep link) ----
  const jumpToSegment = useCallback(
    (segIdx: number) => {
      if (segIdx < 0 || segIdx >= segments.length) return;
      currentSegIdxRef.current = segIdx;
      setCurrentSegIdx(segIdx);
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      setUxState("playing");
      ytPlayerRef.current?.playSegment(segIdx);
      triggerAutoSave(segIdx, "active");
    },
    [segments.length, triggerAutoSave]
  );

  const handleRestart = useCallback(() => {
    if (!user) return;
    void restartSession(videoId, resumeState?.sessionId)
      .then(() => {
        firstAttemptBySegmentRef.current = {};
        setResumeState(null);
        setCombo(0);
        setBestCombo(0);
        setCleanSolveCount(0);
        setIsLastResultClean(false);
        sessionStore.reset();
      })
      .catch(() => {});
  }, [resumeState?.sessionId, sessionStore, user, videoId]);

  return {
    currentSegIdx,
    uxState,
    checkResult,
    setCheckResult,
    wrongAttempts,
    hintLevel,
    setHintLevel,
    combo,
    bestCombo,
    cleanSolveCount,
    isLastResultClean,
    previousRunSnapshot,
    mistakes,
    resumeState,
    resumeLoading,
    previousReview,
    regenerating,
    regenerateError,
    checkAnswerError,
    segments,
    transcriptStatus,
    transcriptTitle: transcriptQuery.data?.title,
    transcriptIsLoading: transcriptQuery.isLoading,
    ytPlayerRef,
    handleSegmentEnd,
    handleAnswerSubmit,
    handleStart,
    handleReplay,
    handleSkip,
    handlePrevious,
    handleResume,
    handleRestart,
    jumpToSegment,
    handleManualTranscriptSaved,
    handleRegenerateTranscript,
  };
}
