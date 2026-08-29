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
import {
  RESTORABLE_UX_STATES,
  saveDictationSessionSnapshot,
  loadDictationSessionSnapshot,
  clearDictationSessionSnapshot,
  type PersistedInputState,
} from "./sessionPersistence";

// uxStates whose in-progress session is worth persisting/protecting — anything
// outside this set (loading, transcript_*) has no session state to lose.
const ACTIVE_SESSION_UX_STATES: UXState[] = [
  "playing",
  "paused_waiting_input",
  "checking_answer",
  "session_completed",
];

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
  // Consecutive correct answers — a hint or a retry doesn't break it, only a wrong
  // submit resets it to 0. "Clean" (first-try, no-hint) solves are tracked separately
  // below via cleanSolveCount/isLastResultClean, for the "First try" badge and recap.
  const [combo, setCombo] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [cleanSolveCount, setCleanSolveCount] = useState(0);
  const [isLastResultClean, setIsLastResultClean] = useState(false);
  // Snapshot of the user's last *completed* run on this video, captured before this
  // visit's autosave can overwrite that row — used for the "vs last run" recap comparison.
  const [previousRunSnapshot, setPreviousRunSnapshot] = useState<{ accuracy: number; totalAttempts: number } | null>(
    null
  );
  // Word/caret position within the current sentence, mirrored up from
  // SentenceWordInput purely so it can be included in the sessionStorage
  // snapshot below — the input box itself still owns this state.
  const [liveInputState, setLiveInputState] = useState<PersistedInputState | null>(null);
  // A restored snapshot's word/caret state, consumed once by SentenceWordInput
  // to seed itself, then cleared so later segment changes reset normally.
  const [restoredInputState, setRestoredInputState] = useState<PersistedInputState | null>(null);

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
  // Guards the sessionStorage restore below to a single attempt per video —
  // set the instant we've decided (found a snapshot or not), so a later
  // background transcript refetch can't re-trigger it.
  const snapshotRestoreAttemptedRef = useRef(false);
  // A video timestamp to seek to once the YouTube player reports ready —
  // set by the snapshot restore if the player isn't ready yet at that point.
  const pendingRestoreSeekSecRef = useRef<number | null>(null);
  const playerReadyForRestoreRef = useRef(false);

  useEffect(() => {
    resumeLoadedRef.current = false;
    snapshotRestoreAttemptedRef.current = false;
    pendingRestoreSeekSecRef.current = null;
    playerReadyForRestoreRef.current = false;
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
    // A transcript never changes mid-session, so there's nothing to gain from
    // revalidating it when the tab regains focus — and doing so used to reset
    // an in-progress dictation session back to the "Start Dictation" screen
    // (see the uxState-sync effect below).
    refetchOnWindowFocus: false,
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

  // ---- Restore an active session persisted in sessionStorage (see
  // sessionPersistence.ts) — takes priority over the "Start Dictation" screen
  // and even the server-side resume banner, since it reflects this exact
  // tab's in-progress state from moments ago (before a remount, refresh, or
  // a background tab getting reclaimed by the browser).
  const applyRestoredSnapshot = useCallback(
    (snapshot: ReturnType<typeof loadDictationSessionSnapshot>): boolean => {
      if (!snapshot || !RESTORABLE_UX_STATES.has(snapshot.uxState)) return false;

      const segIdx = Math.min(Math.max(snapshot.currentSegIdx, 0), Math.max(segments.length - 1, 0));
      currentSegIdxRef.current = segIdx;
      setCurrentSegIdx(segIdx);
      // A snapshot taken mid-check or mid-playback can't be resumed in that
      // exact state — land on "paused_waiting_input" instead so nothing
      // auto-plays or auto-advances on its own.
      const restoredUxState: UXState =
        snapshot.uxState === "playing" || snapshot.uxState === "checking_answer"
          ? "paused_waiting_input"
          : snapshot.uxState;
      uxStateRef.current = restoredUxState;
      setUxState(restoredUxState);
      // A "checking_answer" or "playing" snapshot is inherently transient (mid-flight
      // check, or the brief correct-answer checkmark before auto-advancing) — its
      // checkResult isn't safe to replay since the segment it refers to may not be
      // "current" anymore. Only "paused_waiting_input"/"session_completed" snapshots
      // have a checkResult that genuinely describes the restored segment's state.
      setCheckResult(
        snapshot.uxState === "paused_waiting_input" || snapshot.uxState === "session_completed"
          ? snapshot.checkResult
          : null
      );
      setWrongAttempts(snapshot.wrongAttempts);
      setHintLevel(snapshot.hintLevel);
      setMistakes(snapshot.mistakes);
      setPreviousReview(snapshot.previousReview);
      setCombo(snapshot.combo);
      setBestCombo(snapshot.bestCombo);
      setCleanSolveCount(snapshot.cleanSolveCount);
      setIsLastResultClean(snapshot.isLastResultClean);
      setPreviousRunSnapshot(snapshot.previousRunSnapshot);
      setRestoredInputState(snapshot.inputState);
      firstAttemptBySegmentRef.current = snapshot.firstAttemptBySegment ?? {};

      sessionStore.setSessionId(snapshot.sessionId);
      sessionStore.hydrateAccuracy(snapshot.totalAttempts, snapshot.correctCount);

      // A local-tab snapshot is more precise than the server's "resume"
      // record and takes priority over it — skip the server resume fetch.
      resumeLoadedRef.current = true;
      setResumeState(null);

      if (snapshot.videoCurrentTimeSec > 0) {
        if (playerReadyForRestoreRef.current) {
          ytPlayerRef.current?.seekTo(snapshot.videoCurrentTimeSec, false);
        } else {
          pendingRestoreSeekSecRef.current = snapshot.videoCurrentTimeSec;
        }
      }
      return true;
    },
    [segments.length, sessionStore]
  );

  // Called when the YouTube player reports ready — applies a seek that a
  // snapshot restore queued up before the player existed yet.
  const handlePlayerReady = useCallback(() => {
    playerReadyForRestoreRef.current = true;
    if (pendingRestoreSeekSecRef.current !== null) {
      const timeSec = pendingRestoreSeekSecRef.current;
      pendingRestoreSeekSecRef.current = null;
      ytPlayerRef.current?.seekTo(timeSec, false);
    }
  }, []);

  // Update UX state based on transcript status. Keyed on dataUpdatedAt (not
  // just status/segments.length) because handleRegenerateTranscript forces
  // uxState to "transcript_processing" before refetching — if the refetch
  // lands on the same status ("ready") and the same segment count (the
  // common case when just re-fetching captions for a video that already had
  // a transcript), status/segments.length alone wouldn't change and this
  // effect would never re-run, leaving the "Generating transcript…" screen
  // stuck even though the regenerate succeeded. dataUpdatedAt changes on
  // every successful fetch regardless of whether the content did.
  useEffect(() => {
    if (transcriptQuery.isLoading) {
      setUxState("loading_transcript");
    } else if (transcriptStatus === "processing") {
      setUxState("transcript_processing");
    } else if (transcriptStatus === "failed") {
      setUxState("transcript_failed");
    } else if (transcriptStatus === "ready" && segments.length > 0) {
      // A background refetch of an already-ready transcript (e.g. a
      // stale-data revalidation) must never interrupt or discard an
      // already-active session — only ever adopt "transcript_ready" (the
      // pre-start screen) when a session isn't already underway.
      if (ACTIVE_SESSION_UX_STATES.includes(uxStateRef.current)) return;

      if (!snapshotRestoreAttemptedRef.current) {
        snapshotRestoreAttemptedRef.current = true;
        if (applyRestoredSnapshot(loadDictationSessionSnapshot(videoId))) return;
      }
      setUxState("transcript_ready");
    } else if (transcriptStatus === "ready" && segments.length === 0) {
      // Transcript marked ready but no segments — treat as failed so user gets feedback
      setUxState("transcript_failed");
    }
  }, [transcriptStatus, transcriptQuery.isLoading, transcriptQuery.dataUpdatedAt, segments.length, videoId, applyRestoredSnapshot]);

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
          }
          const nextCombo = combo + 1;
          setCombo(nextCombo);
          setBestCombo((best) => Math.max(best, nextCombo));

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
    clearDictationSessionSnapshot(videoId);
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

  // ---- Pause playback and autosave when the tab is hidden / page is being
  // closed. This must ONLY pause and persist — it must never call setUxState
  // or otherwise touch segment/answer state, since the sessionStorage
  // snapshot effect below (plus the guard in the uxState-sync effect above)
  // is what keeps the active session intact across a hide/show cycle. ----
  useEffect(() => {
    const practicingStates: UXState[] = ["playing", "paused_waiting_input", "checking_answer"];
    const persist = () => {
      // Only autosave if dictation practice actually started this visit —
      // otherwise merely opening a video and switching tabs/closing it
      // spawns a fresh "active" session at segment 0, which then shows up
      // as bogus in-progress state even for a video the user already
      // completed (or never touched).
      if (!user || !practicingStates.includes(uxStateRef.current)) return;
      triggerAutoSave(currentSegIdxRef.current, "active");
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      // Pause the video rather than leaving it playing in the background —
      // the segment/answer state underneath is left completely untouched.
      if (practicingStates.includes(uxStateRef.current)) {
        ytPlayerRef.current?.pauseVideo();
      }
      persist();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", persist);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", persist);
    };
  }, [triggerAutoSave, user]);

  // ---- Persist the active session to sessionStorage on every meaningful
  // change, so a component remount, an accidental page refresh, or a mobile
  // browser reclaiming this backgrounded tab can restore it (see
  // applyRestoredSnapshot above and sessionPersistence.ts). Debounced
  // slightly since typing updates liveInputState on every keystroke. ----
  useEffect(() => {
    if (!ACTIVE_SESSION_UX_STATES.includes(uxState)) return;
    const timeoutId = window.setTimeout(() => {
      const state = useSessionStore.getState();
      saveDictationSessionSnapshot(videoId, {
        uxState,
        currentSegIdx,
        checkResult,
        wrongAttempts,
        hintLevel,
        mistakes,
        previousReview,
        combo,
        bestCombo,
        cleanSolveCount,
        isLastResultClean,
        previousRunSnapshot,
        firstAttemptBySegment: firstAttemptBySegmentRef.current,
        videoCurrentTimeSec: playerStore.currentTimeSec,
        inputState: liveInputState,
        sessionId: state.sessionId,
        totalAttempts: state.totalAttempts,
        correctCount: state.correctCount,
      });
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [
    videoId,
    uxState,
    currentSegIdx,
    checkResult,
    wrongAttempts,
    hintLevel,
    mistakes,
    previousReview,
    combo,
    bestCombo,
    cleanSolveCount,
    isLastResultClean,
    previousRunSnapshot,
    liveInputState,
    playerStore.currentTimeSec,
  ]);

  // Consumed once by SentenceWordInput after it seeds itself from a restored
  // snapshot, so later segment changes go back to resetting normally.
  const consumeRestoredInputState = useCallback(() => setRestoredInputState(null), []);

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
        // An explicit restart is the one thing allowed to discard the
        // sessionStorage snapshot — everything else (tab switches, minimizing,
        // remounts) must leave it intact.
        clearDictationSessionSnapshot(videoId);
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
    restoredInputState,
    consumeRestoredInputState,
    reportInputState: setLiveInputState,
    handlePlayerReady,
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
