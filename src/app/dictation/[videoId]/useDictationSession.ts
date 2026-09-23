import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { YouTubePlayerHandle } from "@/components/YouTubePlayer";
import { usePlayerStore } from "@/store/playerStore";
import { useSessionStore, selectAccuracy } from "@/store/sessionStore";
import { checkAnswer as evaluateAnswer } from "@/lib/utils/text";
import { dashboardKeys } from "@/lib/queries/dashboard";
import { historyMistakesKeys } from "@/lib/queries/historyMistakes";
import type { TranscriptSegment, CheckAnswerResponse, HintLevel, UXState } from "@/lib/types";
import { RESUME_SEEK_DELAY_MS, CORRECT_RESULT_VISIBILITY_DELAY_MS } from "./constants";
import {
  fetchTranscript,
  checkAnswerApi,
  saveProgress,
  fetchResumeSession,
  restartSession,
  regenerateTranscript,
  saveManualTranscript,
  requestTranscriptGeneration,
} from "./api";
import type { ManualSegmentInput } from "@/lib/utils/segment";
import type { MistakeRecord, CompletedSentenceReview, ResumeState } from "./types";
import {
  RESTORABLE_UX_STATES,
  saveDictationSessionSnapshot,
  loadDictationSessionSnapshot,
  clearDictationSessionSnapshot,
  isSnapshotCompatible,
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

// Codes worth a bounded, quiet client-side retry of automatic generation:
// GENERATION_IN_PROGRESS/FETCH_COOLDOWN come with a server-provided
// retryAfterMs; NETWORK_ERROR/TIMEOUT are transient hiccups on our own
// request. Anything else (captions disabled, video restricted, language
// missing, parser errors, ...) is a stable fact this request already
// resolved — retrying it immediately would just repeat the same result, so
// those stop polling and surface the specific message instead.
const AUTO_RETRYABLE_CODES = new Set(["GENERATION_IN_PROGRESS", "FETCH_COOLDOWN", "NETWORK_ERROR", "TIMEOUT"]);
const AUTO_RETRY_MAX_ATTEMPTS = 3;
const AUTO_RETRY_DEFAULT_DELAY_MS = 4000;

interface UseDictationSessionOptions {
  videoId: string;
  user: User | null;
  /** When true, skip the "Start Dictation"/"Resume at sentence N" click-through
   *  screen entirely and land directly in a paused, ready-to-continue state as
   *  soon as the transcript is ready — used for Listening Mode entries, which
   *  must never show an intermediate start screen or autoplay the video. */
  autoEnterPaused?: boolean;
}

/**
 * The core dictation session state machine: loads/generates the transcript,
 * plays each segment, checks answers, tracks mistakes, autosaves progress,
 * and resumes/restarts sessions. This is the single most stateful part of
 * the dictation page — kept as one cohesive hook rather than split further,
 * since its pieces (segment index, playback, answer checking, autosave) are
 * all facets of the same session, not separable concerns.
 */
export function useDictationSession({ videoId, user, autoEnterPaused = false }: UseDictationSessionOptions) {
  const playerStore = usePlayerStore();
  const sessionStore = useSessionStore();
  const queryClient = useQueryClient();

  const [currentSegIdx, setCurrentSegIdx] = useState(0);
  const [uxState, setUxState] = useState<UXState>("loading_transcript");
  const [checkResult, setCheckResult] = useState<CheckAnswerResponse | null>(null);
  const [wrongAttempts, setWrongAttempts] = useState(0);
  const [hintLevel, setHintLevel] = useState<HintLevel>(0);
  // In-memory mistake tracking for the session-review panel at completion
  const [mistakes, setMistakes] = useState<MistakeRecord[]>([]);
  const [resumeState, setResumeState] = useState<ResumeState | null>(null);
  // Drives the transcript query's revision choice (Phase 0) — deliberately
  // SEPARATE from resumeState (which also gets cleared once a local
  // sessionStorage snapshot is restored, purely a resume-banner/handleResume
  // concern below). `undefined` = not resolved yet (query stays disabled);
  // `null` = resolved, no pinned revision (fetch current); a string = fetch
  // exactly that revision. Once resolved from the server's resume check,
  // this must NOT be reset just because the resume banner itself is later
  // dismissed by a local-snapshot restore — the transcript already fetched
  // (or is fetching) against the correct pinned revision by that point.
  const [pinnedRevisionId, setPinnedRevisionId] = useState<string | null | undefined>(undefined);
  const [resumeLoading, setResumeLoading] = useState(false);
  // Flips true once the server resume check has settled one way or another
  // (found a session, found none, or was skipped for a guest) — distinct from
  // resumeLoading, which starts false and is indistinguishable from "not
  // started yet". autoEnterPaused waits on this to avoid racing the fetch.
  const [resumeChecked, setResumeChecked] = useState(false);
  const [previousReview, setPreviousReview] = useState<CompletedSentenceReview | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  // Set when a regenerate/manual-paste/SRT-upload call published a revision
  // different from the one currently displayed while an established lesson
  // was on screen — the lesson deliberately keeps showing its own content
  // (see handleRegenerateTranscript), so this is the only user-facing sign
  // that a newer version exists. Cleared on dismissal paths: explicit
  // restart, video switch, or adopting the new revision via manual save.
  const [pendingRevisionNotice, setPendingRevisionNotice] = useState<string | null>(null);
  // Typed code behind the current transcript-generation failure/wait state
  // (e.g. "FETCH_COOLDOWN", "CAPTIONS_DISABLED"), so the UI can show
  // specific guidance instead of one generic message. Cleared on a new
  // attempt or a fresh video.
  const [autoGenerateErrorCode, setAutoGenerateErrorCode] = useState<string | null>(null);
  // When set, the background auto-generate scheduler has a pending retry —
  // exposed so the UI can show "retrying shortly" instead of a dead end.
  const [nextAutoRetryAt, setNextAutoRetryAt] = useState<number | null>(null);
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
  // Guards src/app/dictation/[videoId]/api.ts's requestTranscriptGeneration
  // call against duplicate concurrent POSTs from React re-renders/StrictMode
  // double-invocation — the server-side lock (see
  // src/lib/youtubeCaptions/lock.ts) is the real cross-request guarantee,
  // this just avoids wasting an obviously-redundant request from this tab.
  const generateInFlightRef = useRef(false);
  const autoRetryTimeoutRef = useRef<number | null>(null);
  const autoRetryCountRef = useRef(0);
  // Bumped whenever the owning context changes from under an in-flight
  // async operation: a video/user switch, or an explicit restart. Any
  // resume-fetch/regenerate callback captures the epoch value in effect at
  // the moment it was issued and checks it against the current value
  // before applying its result — so a response that arrives after the
  // context has moved on can't restore stale state (segment index,
  // pinned revision, resume banner, ...) into the new one.
  const contextEpochRef = useRef(0);
  // Delayed transitions (the correct-answer auto-advance pause, the
  // resume-seek delay) scheduled via scheduleTimeout below — tracked so
  // they can be cancelled together whenever their owning context ends
  // (video/user switch, explicit restart), instead of firing late against
  // state that no longer applies.
  const pendingTimeoutIdsRef = useRef<Set<number>>(new Set());
  const scheduleTimeout = useCallback((fn: () => void, delayMs: number) => {
    const id = window.setTimeout(() => {
      pendingTimeoutIdsRef.current.delete(id);
      fn();
    }, delayMs);
    pendingTimeoutIdsRef.current.add(id);
    return id;
  }, []);
  const clearAllPendingTimeouts = useCallback(() => {
    pendingTimeoutIdsRef.current.forEach((id) => window.clearTimeout(id));
    pendingTimeoutIdsRef.current.clear();
  }, []);

  useEffect(() => {
    // Invalidate any in-flight regenerate/resume-fetch issued for the
    // previous video/user before anything else below runs, so a response
    // that lands after this point can never apply to the new context.
    contextEpochRef.current += 1;
    clearAllPendingTimeouts();
    resumeLoadedRef.current = false;
    snapshotRestoreAttemptedRef.current = false;
    pendingRestoreSeekSecRef.current = null;
    playerReadyForRestoreRef.current = false;
    setPendingRevisionNotice(null);
    // A regenerate left in flight for the previous context is now stale
    // (see the isStale() guard in handleRegenerateTranscript) and will
    // never clear this itself for the new context — reset explicitly so
    // the new video's Regenerate button never gets stuck showing
    // "Regenerating…" for a request that no longer applies to it.
    setRegenerating(false);
    setRegenerateError(null);
    setResumeState(null);
    // Phase 0: the transcript query is gated on pinnedRevisionId being
    // resolved, so it never fetches "current" before the new video's own
    // resume state is known — reset both flags alongside resumeLoadedRef so
    // a video switch re-blocks the query until the new video's resume-fetch
    // effect (below) settles again.
    setResumeChecked(false);
    setPinnedRevisionId(undefined);
    firstAttemptBySegmentRef.current = {};
    // The session store (sessionId, attempt/correct counts) is global and
    // persisted, so it must be wiped whenever the active video changes —
    // otherwise the accuracy shown for this video is actually the running
    // accuracy carried over from whatever video was practiced previously,
    // and a stale sessionId could get reused to save progress against the
    // wrong video's session row.
    useSessionStore.getState().reset();
  }, [videoId, user?.id, clearAllPendingTimeouts]);

  // ---- Transcript query ----
  // Phase 0 (.claude/video-learning-management-plan.md): gated on
  // pinnedRevisionId being resolved (not `undefined`) so resume state
  // resolves FIRST — an existing session fetches its own pinned revision,
  // never "whatever is current now"; a fresh video (no session) fetches
  // current. The query key includes the pinned id (or the "current"
  // sentinel) so a pinned-revision fetch and a current-revision fetch never
  // share a cache entry, even for the same video/language.
  const transcriptQuery = useQuery({
    queryKey: ["transcript", videoId, "en", pinnedRevisionId ?? "current"],
    queryFn: () => fetchTranscript(videoId, pinnedRevisionId ?? undefined, "en"),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "processing" ? 3000 : false;
    },
    enabled: !!videoId && pinnedRevisionId !== undefined,
    // A pinned/current transcript never changes mid-session, so there's
    // nothing to gain from revalidating it when the tab regains focus — and
    // doing so used to reset an in-progress dictation session back to the
    // "Start Dictation" screen (see the uxState-sync effect below).
    refetchOnWindowFocus: false,
  });

  const segments: TranscriptSegment[] = useMemo(
    () => transcriptQuery.data?.segments ?? [],
    [transcriptQuery.data?.segments]
  );
  const transcriptStatus = transcriptQuery.data?.status;
  // The revision actually being displayed/practiced against right now —
  // derived from the fetched segments (same convention page.tsx already
  // uses), never separately tracked state that could drift from what's
  // rendered. Undefined while segments haven't loaded yet.
  const transcriptId = segments[0]?.transcript_id;
  // "Still figuring out which revision to fetch, or fetching/refetching it"
  // — distinct from "no session" so the UI never mistakes "resume still
  // loading" for "nothing to resume" (Phase 0).
  const transcriptPending = pinnedRevisionId === undefined || transcriptQuery.isLoading;

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
      // banner and takes priority over it for display purposes — this only
      // clears the "Resume at sentence N" prompt/handleResume data.
      // pinnedRevisionId (Phase 0) is deliberately left untouched: the
      // server resume-check already resolved it (it runs independently of
      // transcript readiness now, so it has necessarily already settled by
      // the time segments — and therefore this restore — can run at all),
      // and the transcript already fetched against that correct revision.
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
  // just status/segments.length) because a first-generation retry can land
  // on the same status ("ready") and the same segment count as a previous
  // attempt, in which case status/segments.length alone wouldn't change and
  // this effect would never re-run. dataUpdatedAt changes on every
  // successful fetch regardless of whether the content did — including any
  // background revalidation of an already-ready transcript.
  //
  // The active-session guard below reads `uxState` directly (the value
  // from THIS render), not a ref mirror — a ref updated by a separate
  // effect can still hold the previous render's value when both effects
  // have pending updates in the same commit (e.g. a background refetch
  // resolving in the same tick as handleResume's setUxState("playing")),
  // which previously let this effect clobber an action the user had just
  // taken back to "transcript_ready". Reading `uxState` here is always
  // consistent with what was just set, at the cost of this effect also
  // re-running (and no-op-ing via the guard) on every uxState change —
  // harmless, since the guard's own setUxState calls are idempotent.
  useEffect(() => {
    // Phase 0: transcriptPending also covers "resume state not resolved
    // yet, transcript query not even enabled yet" — without this, that
    // window would fall through every branch below and leave uxState stuck
    // at whatever it was, which happens to look like "loading" today only
    // by coincidence of the initial state; explicit is safer.
    if (transcriptPending) {
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
      if (ACTIVE_SESSION_UX_STATES.includes(uxState)) return;

      if (!snapshotRestoreAttemptedRef.current) {
        snapshotRestoreAttemptedRef.current = true;
        const loaded = loadDictationSessionSnapshot(videoId);
        const compatible = isSnapshotCompatible(loaded, {
          videoId,
          userId: user?.id ?? null,
          transcriptId: transcriptId ?? null,
        });
        if (applyRestoredSnapshot(compatible ? loaded : null)) return;
      }
      setUxState("transcript_ready");
    } else if (transcriptStatus === "ready" && segments.length === 0) {
      // Transcript marked ready but no segments — treat as failed so user gets feedback
      setUxState("transcript_failed");
    }
  }, [
    transcriptStatus,
    transcriptPending,
    transcriptQuery.dataUpdatedAt,
    segments.length,
    videoId,
    user?.id,
    transcriptId,
    uxState,
    applyRestoredSnapshot,
  ]);

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
      // Identity (pinned revision) hasn't resolved yet — never send a save
      // built from default/initialization values before we actually know
      // which revision this session belongs to.
      if (pinnedRevisionId === undefined) return;
      const state = useSessionStore.getState();
      // Read every field of this save's context at the same instant,
      // directly from its owning store, rather than closing over a
      // `playerStore.currentTimeSec` prop value from whatever render last
      // recreated this callback (which — since currentTimeSec ticks every
      // ~200ms — would also churn this function's identity constantly and
      // make callers that depend on it, like the pagehide/visibilitychange
      // listeners below, re-register on every tick).
      void saveProgress(
        videoId,
        segmentIndex,
        usePlayerStore.getState().currentTimeSec,
        selectAccuracy(state),
        state.totalAttempts,
        state.sessionId ?? undefined,
        transcriptId,
        status
      )
        .then((r) => {
          if (!state.sessionId) sessionStore.setSessionId(r.sessionId);
          if (status === "completed" && user) {
            // Dashboard/History cache the persisted data this write just
            // changed (completedVideos/avgAccuracy/resumableSessions, error
            // patterns, and mistakes are all derived from learning_sessions
            // + the attempt_logs rows this session accumulated) — mark them
            // stale so returning to either page picks up this session
            // instead of showing pre-completion numbers for up to
            // staleTime. Intermediate "active" autosaves deliberately don't
            // do this: they're too frequent to invalidate on every one
            // without hammering these endpoints for data the user isn't
            // looking at yet.
            void queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(user.id) });
            void queryClient.invalidateQueries({ queryKey: dashboardKeys.errorPatterns(user.id) });
            void queryClient.invalidateQueries({ queryKey: historyMistakesKeys.allForUser(user.id) });
          }
        })
        .catch(() => {
          if (state.sessionId) sessionStore.setSessionId(null);
        });
    },
    [pinnedRevisionId, queryClient, sessionStore, transcriptId, user, videoId]
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
          scheduleTimeout(() => {
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
    [currentSegIdx, segments, sessionStore, triggerAutoSave, wrongAttempts, hintLevel, combo, scheduleTimeout]
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

  // Live-updated mirror of videoId, read from inside triggerAutoGenerate's
  // async callbacks to detect a video switch that happened while a request
  // was in flight — without this, a slow response for a video the user has
  // since navigated away from could clobber the new video's transcriptId/
  // error state with stale data.
  const currentVideoIdRef = useRef(videoId);

  // ---- Reset all background-generation bookkeeping whenever the video
  // changes (and on unmount) — declared BEFORE triggerAutoGenerate's own
  // trigger effect below so it always runs first within the same commit if
  // both fire together (e.g. react-query already has cached "processing"
  // data for a revisited video on the very render videoId changes). ----
  useEffect(() => {
    currentVideoIdRef.current = videoId;
    autoRetryCountRef.current = 0;
    generateInFlightRef.current = false;
    setAutoGenerateErrorCode(null);
    if (autoRetryTimeoutRef.current !== null) {
      window.clearTimeout(autoRetryTimeoutRef.current);
      autoRetryTimeoutRef.current = null;
    }
    setNextAutoRetryAt(null);

    return () => {
      if (autoRetryTimeoutRef.current !== null) {
        window.clearTimeout(autoRetryTimeoutRef.current);
        autoRetryTimeoutRef.current = null;
      }
    };
  }, [videoId]);

  // ---- Background transcript generation with a bounded, server-guided
  // retry — replaces a naive "POST once on mount" that had no way to
  // recover from a contended lock or an active cooldown (both come back
  // without a transcriptId and without ever changing the DB row, so nothing
  // would otherwise prompt a follow-up attempt). See AUTO_RETRYABLE_CODES
  // above for exactly which outcomes get a quiet retry vs. an immediate
  // "transcript_failed" with a specific message. ----
  const triggerAutoGenerate = useCallback(() => {
    if (generateInFlightRef.current) return;
    generateInFlightRef.current = true;
    const requestedForVideoId = videoId;

    const scheduleRetry = (delayMs: number) => {
      if (currentVideoIdRef.current !== requestedForVideoId) return;
      autoRetryCountRef.current += 1;
      setNextAutoRetryAt(Date.now() + delayMs);
      autoRetryTimeoutRef.current = window.setTimeout(triggerAutoGenerate, delayMs);
    };

    requestTranscriptGeneration(videoId)
      .then((result) => {
        generateInFlightRef.current = false;
        if (currentVideoIdRef.current !== requestedForVideoId) return;

        // transcriptId is derived from the transcript query's own segments
        // (Phase 0) — no separate state to set here; the next poll of that
        // query (refetchInterval, above) picks up the newly-published
        // revision once it's ready.
        const code = result.code ?? null;
        setAutoGenerateErrorCode(code);
        if (result.status === "ready" || result.transcriptId) setRegenerateError(null);

        if (code && AUTO_RETRYABLE_CODES.has(code) && autoRetryCountRef.current < AUTO_RETRY_MAX_ATTEMPTS) {
          scheduleRetry(result.retryAfterMs && result.retryAfterMs > 0 ? result.retryAfterMs : AUTO_RETRY_DEFAULT_DELAY_MS);
        } else {
          setNextAutoRetryAt(null);
        }
      })
      .catch((err: unknown) => {
        generateInFlightRef.current = false;
        if (currentVideoIdRef.current !== requestedForVideoId) return;

        const code = (err as { code?: string } | null)?.code ?? null;
        setAutoGenerateErrorCode(code);

        if (code && AUTO_RETRYABLE_CODES.has(code) && autoRetryCountRef.current < AUTO_RETRY_MAX_ATTEMPTS) {
          const retryAfterMs = (err as { retryAfterMs?: number } | null)?.retryAfterMs;
          scheduleRetry(retryAfterMs && retryAfterMs > 0 ? retryAfterMs : AUTO_RETRY_DEFAULT_DELAY_MS);
        } else {
          setNextAutoRetryAt(null);
        }
      });
  }, [videoId]);

  useEffect(() => {
    if (transcriptStatus === "processing" && !transcriptId) {
      triggerAutoGenerate();
    }
    // Only the initial transition into "processing" (or a video change)
    // should kick this off — triggerAutoGenerate's own retry chain handles
    // everything after that, and re-running this on every unrelated
    // re-render would fight with generateInFlightRef's guard for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptStatus === "processing" && !transcriptId, videoId]);

  // Whether there's an established lesson currently on screen worth
  // protecting from a regenerate/manual-save's side effects — a ready
  // transcript with segments loaded, regardless of whether the user has
  // actually pressed Start yet (the pre-start "transcript_ready" screen
  // still has real resume/session context worth not blowing away).
  const hasUsableLesson = transcriptStatus === "ready" && segments.length > 0;

  const handleManualTranscriptSaved = useCallback(
    async (newTranscriptId: string) => {
      if (hasUsableLesson) {
        // Regenerate publishes content; it does not restart the current
        // lesson. An established lesson keeps displaying/practicing its
        // own (pinned, or previously-current) revision — the newly saved
        // one is only adopted via an explicit Restart.
        if (newTranscriptId !== transcriptId) {
          setPendingRevisionNotice("An updated script is available. Restart the lesson to use it.");
        }
        return;
      }
      // No usable lesson yet (e.g. saved from the transcript_failed
      // fallback screen) — nothing to preserve, adopt the new revision.
      setResumeState(null);
      setPinnedRevisionId(null);
      await transcriptQuery.refetch();
    },
    [hasUsableLesson, transcriptId, transcriptQuery]
  );

  // ---- Regenerate transcript, either from YouTube captions (no args) or from
  // caller-supplied segments (manual paste / .srt / .vtt upload). Regenerate
  // publishes transcript content; it does not restart the current learning
  // session. When an established lesson is already on screen (branches A/B/C
  // below), its session identity, pinned revision, displayed segments,
  // selected sentence, counters, and any draft/recovery state are all left
  // completely untouched — only a separate `regenerating` loading flag and,
  // if the publish produced a different revision, a dismissible notice are
  // set. Only when there is no usable lesson yet (branch D — first
  // generation, or retrying from transcript_failed) does this fall back to
  // the original reset-and-reprocess flow, since there is nothing to lose
  // there. ----
  const handleRegenerateTranscript = useCallback(async (providedSegments?: ManualSegmentInput[], importSource?: "srt" | "vtt") => {
    const requestEpoch = contextEpochRef.current;
    const previousTranscriptId = transcriptId;
    const isStale = () => contextEpochRef.current !== requestEpoch;

    setRegenerating(true);
    setRegenerateError(null);
    setPendingRevisionNotice(null);
    // Pausing is a safe, non-navigational action while the new revision is
    // published — it must never seek or (re)start playback.
    ytPlayerRef.current?.pauseVideo();

    if (!hasUsableLesson) {
      clearDictationSessionSnapshot(videoId);
      setAutoGenerateErrorCode(null);
      autoRetryCountRef.current = 0;
      if (autoRetryTimeoutRef.current !== null) {
        window.clearTimeout(autoRetryTimeoutRef.current);
        autoRetryTimeoutRef.current = null;
      }
      setNextAutoRetryAt(null);
      setUxState("transcript_processing");
      currentSegIdxRef.current = 0;
      setCurrentSegIdx(0);
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      setMistakes([]);
      setPreviousReview(null);
      setResumeState(null);
      setPinnedRevisionId(null);
      setCombo(0);
      setBestCombo(0);
      setCleanSolveCount(0);
      setIsLastResultClean(false);
      firstAttemptBySegmentRef.current = {};
    }
    // hasUsableLesson branch: deliberately nothing reset here — session
    // identity, pin, segments, sentence, counters and drafts all stay
    // exactly as they were (branches A/B/C).

    try {
      const result = providedSegments
        ? await saveManualTranscript(videoId, providedSegments, importSource ?? "manual")
        : await regenerateTranscript(videoId);
      if (isStale()) return; // video/user changed or an explicit restart happened meanwhile

      setAutoGenerateErrorCode(result.code ?? null);
      if (hasUsableLesson && result.transcriptId && result.transcriptId !== previousTranscriptId) {
        // Branch B: a different revision was published. It becomes current
        // for future sessions server-side already — the established lesson
        // simply keeps showing what it already has (branch A's "same
        // revision" case needs no notice at all).
        setPendingRevisionNotice("An updated script is available. Restart the lesson to use it.");
      }
    } catch (err) {
      if (isStale()) return;
      setRegenerateError(err instanceof Error ? err.message : "Failed to regenerate transcript.");
      setAutoGenerateErrorCode((err as { code?: string } | null)?.code ?? null);
      // Branch C: an established lesson was never touched above, so there
      // is nothing to roll back — it remains exactly as usable as before.
    } finally {
      if (!isStale()) {
        if (!hasUsableLesson) {
          await transcriptQuery.refetch();
        }
        setRegenerating(false);
      }
    }
  }, [videoId, transcriptQuery, hasUsableLesson, transcriptId]);

  // ---- Load resumable session for authenticated users ----
  // Phase 0: this now runs as soon as videoId/user are known — NOT gated on
  // transcriptStatus === "ready" as before. The transcript query above is
  // itself gated on resumeChecked (its `enabled` flag), so resume state is
  // always resolved BEFORE the transcript fetch decides whether to ask for
  // a pinned revision or "current" — an existing session's own
  // fetchResumeSession call is the authoritative source for which revision
  // it's pinned to, independent of whichever revision a local
  // sessionStorage snapshot (restored later, once segments load, by the
  // sync effect above) happens to remember from this tab's last visit.
  useEffect(() => {
    if (resumeLoadedRef.current) return;
    if (!user) {
      resumeLoadedRef.current = true;
      setResumeChecked(true);
      setPinnedRevisionId(null); // guest: no session possible — fetch current
      return;
    }
    const requestEpoch = contextEpochRef.current;
    setResumeLoading(true);
    fetchResumeSession(videoId)
      .then((data) => {
        // The video/user changed (or an explicit restart ran) while this
        // was in flight — applying it now would restore a session/revision
        // that belongs to a context the user has already left.
        if (contextEpochRef.current !== requestEpoch) return;
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
            transcriptId: data.session.transcriptId,
          });
          // null (no pinned revision on a legacy/pre-Phase-0 row) falls back
          // to fetching current, same as "no session at all".
          setPinnedRevisionId(data.session.transcriptId ?? null);
        } else {
          setPinnedRevisionId(null);
        }
      })
      .catch(() => {
        if (contextEpochRef.current !== requestEpoch) return;
        // Resume check failed (network error, etc.) — fetch current rather
        // than leaving the transcript query blocked indefinitely.
        setPinnedRevisionId(null);
      })
      .finally(() => {
        if (contextEpochRef.current !== requestEpoch) return;
        resumeLoadedRef.current = true;
        setResumeLoading(false);
        setResumeChecked(true);
      });
  }, [user, videoId]);

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
        userId: user?.id ?? null,
        transcriptId: transcriptId ?? null,
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
    user?.id,
    transcriptId,
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
      scheduleTimeout(() => {
        ytPlayerRef.current?.seekTo(resumeTimeSec, true);
      }, RESUME_SEEK_DELAY_MS);
    }
  }, [resumeState, segments.length, sessionStore, scheduleTimeout]);

  // ---- Auto-enter a paused, ready-to-continue state for Listening Mode
  // entries (see autoEnterPaused) — the equivalent of clicking "Start
  // Dictation"/"Resume at sentence N", minus the click and minus autoplay.
  // Waits for the resume check to settle first so it doesn't race the fetch
  // and mistake "no saved progress" for "still loading". Reuses the same
  // pending-seek/player-ready plumbing as the sessionStorage snapshot restore
  // above, since the player may not be ready yet this early in the mount.
  const autoEnterAttemptedRef = useRef(false);
  useEffect(() => {
    if (!autoEnterPaused || autoEnterAttemptedRef.current) return;
    if (uxState !== "transcript_ready" || segments.length === 0 || !resumeChecked) return;
    autoEnterAttemptedRef.current = true;

    if (resumeState) {
      const segIdx = Math.min(Math.max(resumeState.currentSegmentIndex, 0), segments.length - 1);
      sessionStore.setSessionId(resumeState.sessionId);
      sessionStore.hydrateAccuracy(
        resumeState.totalAttempts,
        Math.round((resumeState.accuracy / 100) * resumeState.totalAttempts)
      );
      currentSegIdxRef.current = segIdx;
      setCurrentSegIdx(segIdx);
      setResumeState(null);
      setUxState("paused_waiting_input");
      const resumeTimeSec = resumeState.videoCurrentTimeSec;
      if (resumeTimeSec > 0) {
        if (playerReadyForRestoreRef.current) {
          ytPlayerRef.current?.seekTo(resumeTimeSec, false);
        } else {
          pendingRestoreSeekSecRef.current = resumeTimeSec;
        }
      }
    } else {
      // No saved progress: sentence 1, timestamp 0 — which is already where a
      // freshly loaded player sits, so no seek is needed, just leave the
      // "Start Dictation" screen for the paused practicing view.
      triggerAutoSave(0, "active");
      setUxState("paused_waiting_input");
    }
  }, [autoEnterPaused, uxState, segments.length, resumeChecked, resumeState, sessionStore, triggerAutoSave]);

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

  // ---- Listening Mode continuous playback: silently keep currentSegIdx in
  // sync with whatever sentence the playhead is inside, as reported by
  // YouTubePlayer's continuous-mode tick. Unlike jumpToSegment/handleSegmentEnd,
  // this never touches checkResult/hint/uxState — it's just an index sync, not
  // a navigation action, and fires many times per playback as sentences pass. ----
  const handleActiveSegmentChange = useCallback((segIdx: number) => {
    if (segIdx === currentSegIdxRef.current) return;
    currentSegIdxRef.current = segIdx;
    setCurrentSegIdx(segIdx);
  }, []);

  const handleRestart = useCallback(() => {
    if (!user) return;
    void restartSession(videoId, resumeState?.sessionId)
      .then(() => {
        // An explicit restart establishes a new context — invalidate any
        // regenerate/resume-fetch still in flight for the abandoned
        // session so its late result can't restore stale state into what
        // comes next, and cancel any pending delayed transition (e.g. an
        // answer's auto-advance) tied to the session being abandoned.
        contextEpochRef.current += 1;
        clearAllPendingTimeouts();
        setPendingRevisionNotice(null);
        setRegenerating(false);
        setRegenerateError(null);
        // An explicit restart is the one thing allowed to discard the
        // sessionStorage snapshot — everything else (tab switches, minimizing,
        // remounts) must leave it intact.
        clearDictationSessionSnapshot(videoId);
        firstAttemptBySegmentRef.current = {};
        setResumeState(null);
        // Phase 0: the abandoned round's pin no longer applies — the next
        // round (created lazily on the next save-progress call) pins
        // whatever is current at that time, so re-target the transcript
        // query to current now rather than continuing to show the
        // abandoned round's revision.
        setPinnedRevisionId(null);
        setCombo(0);
        setBestCombo(0);
        setCleanSolveCount(0);
        setIsLastResultClean(false);
        sessionStore.reset();
        // Restart marks the session "abandoned" server-side (see
        // /api/session/restart) — that changes resumableSessions on
        // Dashboard/History. It never touches attempt_logs, so
        // error-patterns/history-mistakes are unaffected and deliberately
        // left alone.
        if (user) void queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(user.id) });
      })
      .catch(() => {});
  }, [queryClient, resumeState?.sessionId, sessionStore, user, videoId, clearAllPendingTimeouts]);

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
    pendingRevisionNotice,
    dismissPendingRevisionNotice: () => setPendingRevisionNotice(null),
    autoGenerateErrorCode,
    nextAutoRetryAt,
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
    handleActiveSegmentChange,
    handleManualTranscriptSaved,
    handleRegenerateTranscript,
  };
}
