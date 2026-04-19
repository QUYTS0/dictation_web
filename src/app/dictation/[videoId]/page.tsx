"use client";

import { use, useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { clsx } from "clsx";

import YouTubePlayer, { type YouTubePlayerHandle } from "@/components/YouTubePlayer";
import DictationInput from "@/components/DictationInput";
import HintDisplay from "@/components/HintDisplay";
import AIExplainer from "@/components/AIExplainer";
import ProgressBar from "@/components/ProgressBar";
import UserButton from "@/components/UserButton";
import VocabularySaveButton from "@/components/VocabularySaveButton";

import { usePlayerStore } from "@/store/playerStore";
import { useSessionStore, selectAccuracy } from "@/store/sessionStore";
import { useAuth, useRequireAuth } from "@/context/auth";
import type {
  TranscriptResponse,
  TranscriptSegment,
  CheckAnswerResponse,
  MatchMode,
  HintLevel,
  UXState,
  DiffToken,
  ResumeSessionResponse,
  VocabularyItem,
} from "@/lib/types";

// ---- Inline types ----

interface MistakeRecord {
  segIdx: number;
  expectedText: string;
  userText: string;
  diff: DiffToken[];
}

type LessonItemType = "word" | "phrase" | "sentence";
type SavedFilter = "all" | LessonItemType;
type RightPanelTab = "saved" | "script";
type VideoSizeMode = "standard" | "large";

type LessonSavedItem = VocabularyItem & { type: LessonItemType };

interface CompletedSentenceReview {
  segmentIndex: number;
  expectedText: string;
  firstUserText: string;
  diff: DiffToken[];
}

interface ScriptSelectionPopoverState {
  segmentIndex: number;
  selectedText: string;
  selectedWordCount: number;
  sentenceText: string;
  x: number;
  y: number;
}

function getSelectedType(wordCount: number): LessonItemType | null {
  if (wordCount <= 0) return null;
  if (wordCount === 1) return "word";
  return "phrase";
}

function getSavedFilterLabel(filter: SavedFilter) {
  if (filter === "all") return "All";
  if (filter === "word") return "Words";
  if (filter === "phrase") return "Phrases";
  return "Sentences";
}

function splitSentenceIntoWords(sentence: string) {
  return sentence.trim().split(/\s+/).filter(Boolean);
}

// ---- Data fetching ----

async function fetchTranscript(videoId: string): Promise<TranscriptResponse> {
  const res = await fetch(`/api/transcript/${videoId}?lang=en`);
  if (!res.ok) throw new Error("Failed to fetch transcript");
  return res.json();
}

async function checkAnswer(
  segmentIndex: number,
  userText: string,
  expectedText: string,
  matchMode: MatchMode,
  sessionId?: string
): Promise<CheckAnswerResponse> {
  const res = await fetch("/api/dictation/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segmentIndex, userText, expectedText, matchMode, sessionId }),
  });
  if (!res.ok) throw new Error("Failed to check answer");
  return res.json();
}

async function saveProgress(
  videoId: string,
  segmentIndex: number,
  videoCurrentTimeSec: number,
  accuracy: number,
  totalAttempts: number,
  sessionId?: string,
  transcriptId?: string,
  status: "active" | "completed" | "abandoned" = "active"
): Promise<{ sessionId: string }> {
  const res = await fetch("/api/session/save-progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      youtubeVideoId: videoId,
      transcriptId,
      currentSegmentIndex: segmentIndex,
      videoCurrentTimeSec,
      accuracy,
      totalAttempts,
      status,
    }),
  });
  if (!res.ok) throw new Error("Failed to save progress");
  return res.json();
}

async function fetchResumeSession(videoId: string): Promise<ResumeSessionResponse> {
  const res = await fetch(`/api/session/resume?videoId=${encodeURIComponent(videoId)}`);
  if (!res.ok) throw new Error("Failed to fetch resume session");
  return res.json();
}

async function restartSession(videoId: string, sessionId?: string): Promise<void> {
  const res = await fetch("/api/session/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, sessionId }),
  });
  if (!res.ok) throw new Error("Failed to restart session");
}

// ---- Page component ----

interface PageProps {
  params: Promise<{ videoId: string }>;
}

interface ResumeState {
  sessionId: string;
  currentSegmentIndex: number;
  videoCurrentTimeSec: number;
}

// Let the embedded player seek after the segment playback command settles.
const RESUME_SEEK_DELAY_MS = 150;
const SCRIPT_POPOVER_MAX_SIDE_MARGIN_PX = 160;
const SCRIPT_POPOVER_MIN_SIDE_MARGIN_PX = 24;
const SCRIPT_POPOVER_VIEWPORT_MARGIN_FACTOR = 0.2;
const SCRIPT_POPOVER_VERTICAL_OFFSET_PX = 12;
const SCRIPT_POPOVER_MAX_WIDTH_PX = 320;
const VIDEO_SIZE_MODE_STORAGE_KEY = "dictation.video-size-mode";
const VIDEO_SIZE_MODE_CLASS: Record<VideoSizeMode, string> = {
  standard: "max-w-lg",
  large: "max-w-5xl",
};

function buildAiExplainPayload({
  selectedType,
  selectedText,
  sentenceText,
  userText,
}: {
  selectedType: LessonItemType | null;
  selectedText: string;
  sentenceText: string;
  userText: string;
}) {
  if (selectedType && selectedText) {
    return {
      buttonLabel: `Explain selected ${selectedType}`,
      expectedText: `Explain this ${selectedType} from a dictation lesson: "${selectedText}". Source sentence: "${sentenceText}"`,
      userText: selectedText,
    };
  }

  return {
    buttonLabel: "Explain this sentence",
    expectedText: sentenceText,
    userText,
  };
}

export default function DictationPage({ params }: PageProps) {
  const { videoId } = use(params);
  const { user } = useAuth();
  const requireAuth = useRequireAuth();

  // Stores
  const playerStore = usePlayerStore();
  const sessionStore = useSessionStore();
  const accuracy = selectAccuracy(sessionStore);
  const queryClient = useQueryClient();

  // Local state
  const [currentSegIdx, setCurrentSegIdx] = useState(0);
  const [uxState, setUxState] = useState<UXState>("loading_transcript");
  const [checkResult, setCheckResult] = useState<CheckAnswerResponse | null>(null);
  const [wrongAttempts, setWrongAttempts] = useState(0);
  const [hintLevel, setHintLevel] = useState<HintLevel>(0);
  const [transcriptId, setTranscriptId] = useState<string | undefined>();
  const [isRegenerating, setIsRegenerating] = useState(false);
  // In-memory mistake tracking for the session-review panel at completion
  const [mistakes, setMistakes] = useState<MistakeRecord[]>([]);
  const [resumeState, setResumeState] = useState<ResumeState | null>(null);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [inputFocusSignal, setInputFocusSignal] = useState(0);
  const [learningItems, setLearningItems] = useState<LessonSavedItem[]>([]);
  const [learningError, setLearningError] = useState<string | null>(null);
  const [learningSaving, setLearningSaving] = useState(false);
  const [learningDeletingId, setLearningDeletingId] = useState<string | null>(null);
  const [showLearningPanel, setShowLearningPanel] = useState(true);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("saved");
  const [savedFilter, setSavedFilter] = useState<SavedFilter>("all");
  const [videoSizeMode, setVideoSizeMode] = useState<VideoSizeMode>("standard");
  const [scriptPopover, setScriptPopover] = useState<ScriptSelectionPopoverState | null>(null);
  const [scriptShowAI, setScriptShowAI] = useState(false);
  const [scriptAiReady, setScriptAiReady] = useState(false);
  const [scriptPopoverNoteMode, setScriptPopoverNoteMode] = useState(false);
  const [previousReview, setPreviousReview] = useState<CompletedSentenceReview | null>(null);
  const [showVideo, setShowVideo] = useState(true);

  const ytPlayerRef = useRef<YouTubePlayerHandle>(null);
  // Keep lesson note draft in a ref (not state) so typing in note inputs
  // does not trigger full-page rerenders and input lag on heavy lesson UI.
  const learningNoteDraftRef = useRef("");
  const scriptPopoverNoteInputRef = useRef<HTMLInputElement>(null);
  const scriptTextContainerRef = useRef<HTMLDivElement>(null);
  const scriptPopoverRef = useRef<HTMLDivElement>(null);
  // Tracks whether the user manually triggered a replay while already paused
  // (keyboard shortcut / Replay button while input is visible). In this case we keep the
  // input and its typed words intact when the segment ends.
  const isManualReplayWhilePaused = useRef(false);
  // Ref mirror of currentSegIdx — lets handleSegmentEnd guard against stale
  // callbacks that fire after the user has already submitted early and advanced.
  const currentSegIdxRef = useRef(0);
  const resumeLoadedRef = useRef(false);
  const previousShowVideoRef = useRef(showVideo);
  const firstAttemptBySegmentRef = useRef<Record<number, string>>({});

  useEffect(() => {
    resumeLoadedRef.current = false;
    setResumeState(null);
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

      try {
        const result = await checkAnswer(
          currentSegIdx,
          userText,
          segments[currentSegIdx].text,
          "relaxed",
          sessionStore.sessionId ?? undefined
        );

        setCheckResult(result);
        sessionStore.incrementAttempt(result.isCorrect);

        if (result.isCorrect) {
          setPreviousReview({
            segmentIndex: currentSegIdx,
            expectedText: segments[currentSegIdx].text,
            firstUserText:
              firstAttemptBySegmentRef.current[currentSegIdx] ??
              (result.normalizedUser || userText),
            diff: result.diff ?? [],
          });
          setWrongAttempts(0);
          setHintLevel(0);
          setCheckResult(null);

          const nextIdx = currentSegIdx + 1;
          triggerAutoSave(nextIdx, "active");

          if (nextIdx < segments.length) {
            currentSegIdxRef.current = nextIdx;
            setCurrentSegIdx(nextIdx);
            setUxState("playing");
            ytPlayerRef.current?.playSegment(nextIdx);
          } else {
            setUxState("session_completed");
            triggerAutoSave(nextIdx, "completed");
          }
        } else {
          const newWrong = wrongAttempts + 1;
          setWrongAttempts(newWrong);
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
      } catch {
        setUxState("paused_waiting_input");
      }
    },
    [currentSegIdx, segments, sessionStore, triggerAutoSave, wrongAttempts]
  );

  // ---- Start session (seek to segment 0 and play) ----
  const handleStart = useCallback(() => {
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

  // ---- Force-regenerate transcript ----
  const handleRegenerate = useCallback(async () => {
    setIsRegenerating(true);
    setTranscriptId(undefined);
    try {
      const res = await fetch("/api/transcript/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, force: true }),
      });
      if (!res.ok) throw new Error("Regenerate request failed");
      // Reset UI state back to loading so the query refetch picks up the
      // new "processing" transcript and starts polling.
      setUxState("loading_transcript");
      setCurrentSegIdx(0);
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      await queryClient.invalidateQueries({ queryKey: ["transcript", videoId] });
    } catch {
      // Ignore errors — the user can try again
    } finally {
      setIsRegenerating(false);
    }
  }, [videoId, queryClient]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (e.shiftKey && e.code === "Space") {
        e.preventDefault();
        handleReplay();
        return;
      }

      if (e.shiftKey && e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrevious();
        return;
      }

      if (e.shiftKey && e.key === "ArrowRight") {
        e.preventDefault();
        handleSkip();
        return;
      }

      if (!isTypingTarget && e.key === "/") {
        e.preventDefault();
        setInputFocusSignal((v) => v + 1);
        return;
      }

      if (isTypingTarget) return;
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleReplay, handleSkip, handlePrevious]);

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

  // ---- Load resumable session for authenticated users ----
  useEffect(() => {
    if (!user || transcriptStatus !== "ready" || resumeLoadedRef.current) return;
    setResumeLoading(true);
    fetchResumeSession(videoId)
      .then((data) => {
        if (data.session) {
          setResumeState({
            sessionId: data.session.sessionId,
            currentSegmentIndex: data.session.currentSegmentIndex,
            videoCurrentTimeSec: data.session.videoCurrentTimeSec,
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
    const persist = () => triggerAutoSave(currentSegIdxRef.current, "active");
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

  const handleRestart = useCallback(() => {
    if (!user) return;
    void restartSession(videoId, resumeState?.sessionId)
      .then(() => {
        setResumeState(null);
        sessionStore.setSessionId(null);
      })
      .catch(() => {});
  }, [resumeState?.sessionId, sessionStore, user, videoId]);

  const currentSegment = segments[currentSegIdx];

  // Derived flag: show dictation input during playback and while paused/checking
  const shouldShowInput =
    (uxState === "paused_waiting_input" ||
      uxState === "checking_answer" ||
      uxState === "playing") &&
    !!currentSegment;

  const lessonSavedInCurrentVideo = useMemo(
    () => learningItems.filter((item) => item.video_id === videoId),
    [learningItems, videoId]
  );
  const filteredSavedItems = useMemo(() => {
    if (savedFilter === "all") return lessonSavedInCurrentVideo;
    return lessonSavedInCurrentVideo.filter((item) => item.type === savedFilter);
  }, [lessonSavedInCurrentVideo, savedFilter]);
  const shouldShowPreviousReview =
    !!previousReview &&
    previousReview.segmentIndex === currentSegIdx - 1 &&
    uxState !== "session_completed";
  const scriptSelectedType = getSelectedType(scriptPopover?.selectedWordCount ?? 0);
  const scriptAiPayload = buildAiExplainPayload({
    selectedType: scriptSelectedType,
    selectedText: scriptPopover?.selectedText ?? "",
    sentenceText: scriptPopover?.sentenceText ?? "",
    userText: scriptPopover?.selectedText ?? "",
  });
  const segmentsByIndex = useMemo(
    () => new Map(segments.map((segment) => [segment.segmentIndex, segment])),
    [segments]
  );
  const scriptContextSegments = useMemo(
    () =>
      segments.filter(
        (segment) =>
          segment.segmentIndex >= currentSegIdx &&
          segment.segmentIndex <= currentSegIdx + 2
      ),
    [currentSegIdx, segments]
  );
  const shouldRenderVideoPlayer =
    uxState !== "loading_transcript" &&
    uxState !== "transcript_processing" &&
    uxState !== "transcript_failed";
  const videoBlock = shouldRenderVideoPlayer && (
    <div className={clsx("mx-auto w-full transition-all duration-200", VIDEO_SIZE_MODE_CLASS[videoSizeMode])}>
      <div className={clsx(!showVideo && "h-0 overflow-hidden pointer-events-none")} aria-hidden={!showVideo}>
        <YouTubePlayer
          ref={ytPlayerRef}
          videoId={videoId}
          segments={segments}
          onSegmentEnd={handleSegmentEnd}
        />
      </div>
      {!showVideo && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-700">Audio focus mode</p>
            <p className="text-xs text-slate-500 truncate">
              Video is hidden. Playback and transport controls remain active.
            </p>
          </div>
          <button
            onClick={() => setShowVideo(true)}
            className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Show video
          </button>
        </div>
      )}
    </div>
  );

  useEffect(() => {
    const wasShowingVideo = previousShowVideoRef.current;
    if (!wasShowingVideo && showVideo) {
      ytPlayerRef.current?.seekTo(playerStore.currentTimeSec, uxState === "playing");
    }
    previousShowVideoRef.current = showVideo;
  }, [showVideo, playerStore.currentTimeSec, uxState]);

  useEffect(() => {
    if (!showLearningPanel || rightPanelTab !== "script") return;
    const container = scriptTextContainerRef.current;
    if (!container) return;
    const currentCard = container.querySelector<HTMLElement>(
      `[data-script-segment-index="${currentSegIdx}"]`
    );
    currentCard?.scrollIntoView({ block: "nearest" });
  }, [currentSegIdx, rightPanelTab, showLearningPanel]);

  const clearScriptSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) selection.removeAllRanges();
    setScriptPopover(null);
  }, []);

  // Intentionally ref-only updates: keep typing smooth without rerendering
  // the entire lesson screen on every note keystroke.
  const handleLearningNoteChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    learningNoteDraftRef.current = event.target.value;
  }, []);

  const clearLearningNoteInputs = useCallback(() => {
    learningNoteDraftRef.current = "";
    if (scriptPopoverNoteInputRef.current) scriptPopoverNoteInputRef.current.value = "";
  }, []);

  const saveLessonCaptureAtSegment = useCallback(
    (text: string, type: LessonItemType, segmentIndex: number, sentenceContext: string) => {
      const trimmedText = text.trim();
      if (!trimmedText) return;

      const saveNote = learningNoteDraftRef.current.trim();
      requireAuth(() => {
        setLearningSaving(true);
        setLearningError(null);
        void fetch("/api/vocabulary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId,
            segmentIndex,
            term: trimmedText,
            sentenceContext,
            note: saveNote || undefined,
          }),
        })
          .then(async (res) => {
            if (!res.ok) throw new Error("Failed to save vocabulary item");
            const data = (await res.json()) as { item: VocabularyItem };
            const item: LessonSavedItem = {
              ...data.item,
              type,
              note: data.item.note ?? "",
            };
            setLearningItems((prev) => {
              // API can return an existing row (upsert-like behavior), so we update in place.
              // New items are prepended so the latest additions stay easy to scan.
              const existingIndex = prev.findIndex((existing) => existing.id === item.id);
              if (existingIndex === -1) return [item, ...prev];
              const next = [...prev];
              next[existingIndex] = item;
              return next;
            });
            clearLearningNoteInputs();
            setShowLearningPanel(true);
            if (type !== "sentence") {
              clearScriptSelection();
            }
          })
          .catch((err: unknown) => {
            const message =
              err instanceof Error && err.message
                ? err.message
                : "Failed to save learning item. Please try again.";
            setLearningError(message);
          })
          .finally(() => {
            setLearningSaving(false);
          });
      });
    },
    [clearLearningNoteInputs, clearScriptSelection, requireAuth, videoId]
  );

  const deleteLessonCapture = useCallback(
    (itemId: string) => {
      requireAuth(() => {
        setLearningDeletingId(itemId);
        setLearningError(null);
        void fetch(`/api/vocabulary?id=${encodeURIComponent(itemId)}`, {
          method: "DELETE",
        })
          .then(async (res) => {
            if (!res.ok) {
              const data = (await res.json().catch(() => ({}))) as { error?: string };
              throw new Error(data.error || "Failed to delete saved item");
            }
            setLearningItems((prev) => prev.filter((item) => item.id !== itemId));
          })
          .catch((err: unknown) => {
            const message =
              err instanceof Error && err.message
                ? err.message
                : "Failed to delete saved item. Please try again.";
            setLearningError(message);
          })
          .finally(() => {
            setLearningDeletingId(null);
          });
      });
    },
    [requireAuth]
  );

  const handleScriptMouseUp = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!scriptTextContainerRef.current) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setScriptPopover(null);
      return;
    }

    const selectedText = selection.toString().replace(/\s+/g, " ").trim();
    if (!selectedText) {
      setScriptPopover(null);
      return;
    }

    const range = selection.getRangeAt(0);
    if (!scriptTextContainerRef.current.contains(range.commonAncestorContainer)) {
      return;
    }

    const anchorElement =
      range.commonAncestorContainer instanceof HTMLElement
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const segmentElement = anchorElement?.closest<HTMLElement>("[data-script-segment-index]");
    if (!segmentElement) return;

    const segmentIndex = parseInt(segmentElement.dataset.scriptSegmentIndex ?? "", 10);
    const segment = segmentsByIndex.get(segmentIndex);
    if (!Number.isFinite(segmentIndex) || !segment) return;

    const selectedWordCount = splitSentenceIntoWords(selectedText).length;
    const rect = range.getBoundingClientRect();
    const popoverHorizontalMargin = Math.min(
      SCRIPT_POPOVER_MAX_SIDE_MARGIN_PX,
      Math.max(SCRIPT_POPOVER_MIN_SIDE_MARGIN_PX, window.innerWidth * SCRIPT_POPOVER_VIEWPORT_MARGIN_FACTOR)
    );
    const x = Math.min(
      Math.max(rect.left + rect.width / 2, popoverHorizontalMargin),
      window.innerWidth - popoverHorizontalMargin
    );
    const y = Math.max(rect.top - SCRIPT_POPOVER_VERTICAL_OFFSET_PX, SCRIPT_POPOVER_VERTICAL_OFFSET_PX);

    setScriptShowAI(false);
    setScriptAiReady(false);
    setScriptPopoverNoteMode(false);
    setScriptPopover({
      segmentIndex,
      selectedText,
      selectedWordCount,
      sentenceText: segment.text,
      x,
      y,
    });
  }, [segmentsByIndex]);

  const handleScriptPopoverAction = useCallback(
    (type: "word" | "phrase" | "sentence" | "explain" | "note") => {
      if (!scriptPopover) return;
      const segment = segmentsByIndex.get(scriptPopover.segmentIndex);
      if (!segment) return;

      if (type === "explain") {
        setScriptPopoverNoteMode(false);
        setScriptShowAI(true);
        return;
      }
      if (type === "note") {
        setScriptPopoverNoteMode(true);
        window.setTimeout(() => scriptPopoverNoteInputRef.current?.focus(), 10);
        return;
      }

      setScriptPopoverNoteMode(false);
      const textToSave =
        type === "sentence" ? segment.text : scriptPopover.selectedText;
      void saveLessonCaptureAtSegment(textToSave, type, segment.segmentIndex, segment.text);
      clearScriptSelection();
      setScriptShowAI(false);
    },
    [clearScriptSelection, saveLessonCaptureAtSegment, scriptPopover, segmentsByIndex]
  );

  useEffect(() => {
    clearLearningNoteInputs();
  }, [clearLearningNoteInputs, currentSegIdx, currentSegment?.text]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(VIDEO_SIZE_MODE_STORAGE_KEY);
    if (saved === "standard" || saved === "large") {
      setVideoSizeMode(saved);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIDEO_SIZE_MODE_STORAGE_KEY, videoSizeMode);
  }, [videoSizeMode]);

  useEffect(() => {
    clearScriptSelection();
    setScriptShowAI(false);
    setScriptAiReady(false);
    setScriptPopoverNoteMode(false);
  }, [clearScriptSelection, videoId]);

  useEffect(() => {
    if (!scriptShowAI) setScriptAiReady(false);
  }, [scriptShowAI]);

  useEffect(() => {
    if (!scriptPopover) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        clearScriptSelection();
        setScriptPopoverNoteMode(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [clearScriptSelection, scriptPopover]);

  useEffect(() => {
    if (scriptPopover) {
      scriptPopoverRef.current?.focus();
      return;
    }
    setScriptPopoverNoteMode(false);
  }, [scriptPopover]);

  // ---- Render ----
  return (
    <div className="min-h-screen flex flex-col">
      {/* Top bar */}
      <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-4">
        <Link href="/" className="text-indigo-600 hover:text-indigo-800 text-sm font-medium">
          ← Back
        </Link>
        <h1 className="text-base font-bold text-slate-800 truncate flex-1">
          English Dictation Trainer
        </h1>
        {/* Regenerate button — shown when a transcript is loaded so user can fix timestamp issues */}
        {(uxState === "transcript_ready" || uxState === "playing" || uxState === "paused_waiting_input" || uxState === "checking_answer") && (
          <button
            onClick={handleRegenerate}
            disabled={isRegenerating}
            title="Re-fetch captions from YouTube if sentences don't match the audio"
            aria-label={isRegenerating ? "Regenerating transcript…" : "Regenerate transcript"}
            className="text-xs text-slate-400 hover:text-amber-600 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {isRegenerating ? "⏳ Regenerating…" : "🔄 Regenerate"}
          </button>
        )}
        <span className="text-xs text-slate-400 font-mono hidden sm:block">{videoId}</span>
        <UserButton />
      </header>

      <main
        className={clsx(
          "flex-1 flex flex-col lg:flex-row gap-6 p-4 lg:p-6 max-w-7xl mx-auto w-full transition-all duration-300",
          !showLearningPanel && "lg:justify-center"
        )}
      >
        {/* Primary lesson column */}
        <div
          className={clsx(
            "flex flex-col gap-4 transition-all duration-300",
            showLearningPanel ? "lg:w-2/3" : "lg:w-3/4 xl:w-2/3"
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-700">Video</p>
            <div className="flex items-center gap-2">
              <div className="rounded-lg border border-slate-300 p-0.5 flex items-center">
                <button
                  onClick={() => setVideoSizeMode("standard")}
                  className={clsx(
                    "px-2.5 py-1 text-xs rounded-md transition-colors",
                    videoSizeMode === "standard"
                      ? "bg-slate-200 text-slate-800"
                      : "text-slate-600 hover:bg-slate-100"
                  )}
                >
                  Standard
                </button>
                <button
                  onClick={() => setVideoSizeMode("large")}
                  className={clsx(
                    "px-2.5 py-1 text-xs rounded-md transition-colors",
                    videoSizeMode === "large"
                      ? "bg-slate-200 text-slate-800"
                      : "text-slate-600 hover:bg-slate-100"
                  )}
                >
                  Large
                </button>
              </div>
              <button
                onClick={() => setShowVideo((v) => !v)}
                className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                {showVideo ? "Audio focus mode" : "Exit audio focus"}
              </button>
            </div>
          </div>

          {/* YouTube Player */}
          <div className="w-full">
            {videoBlock}
          </div>

          {/* Progress bar */}
          {segments.length > 0 && (
            <ProgressBar
              currentIndex={currentSegIdx}
              totalSegments={segments.length}
              accuracy={accuracy}
            />
          )}

          {/* Replay / Skip controls */}
          {(uxState === "paused_waiting_input" || uxState === "playing") && (
            <div className="flex gap-2">
              <button
                onClick={handlePrevious}
                disabled={currentSegIdx === 0}
                className="flex-1 py-2 rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Previous sentence (Shift+←)"
              >
                ⏮ Prev (Shift+←)
              </button>
              <button
                onClick={handleReplay}
                className="flex-1 py-2 rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50 transition-colors"
                title="Replay (Shift+Space)"
              >
                🔁 Replay (Shift+Space)
              </button>
              <button
                onClick={handleSkip}
                disabled={currentSegIdx >= segments.length - 1}
                className="flex-1 py-2 rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Next sentence (Shift+→)"
              >
                ⏭ Next (Shift+→)
              </button>
            </div>
          )}

          {/* UX State indicators */}
          {uxState === "loading_transcript" && (
            <StatusCard icon="⏳" title="Loading transcript…" description="Fetching transcript from the database." />
          )}

          {uxState === "transcript_processing" && (
            <StatusCard
              icon="🔄"
              title="Generating transcript…"
              description="This may take a moment. The page will update automatically."
              pulse
            />
          )}

          {uxState === "transcript_failed" && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-5 flex flex-col gap-2">
              <p className="text-2xl">❌</p>
              <p className="font-semibold text-slate-800">Transcript failed</p>
              <p className="text-sm text-slate-500">
                Could not generate a transcript for this video. You can try re-fetching from YouTube.
              </p>
              <button
                onClick={handleRegenerate}
                disabled={isRegenerating}
                aria-label={isRegenerating ? "Regenerating transcript…" : "Retry or regenerate transcript"}
                className="self-start mt-1 px-4 py-2 rounded-xl bg-amber-500 text-white font-semibold text-sm hover:bg-amber-600 disabled:opacity-50 transition-colors"
              >
                {isRegenerating ? "⏳ Regenerating…" : "🔄 Retry / Regenerate transcript"}
              </button>
            </div>
          )}

          {uxState === "transcript_ready" && segments.length > 0 && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 flex flex-col gap-3">
              <p className="text-emerald-700 font-semibold">
                ✅ Transcript ready — {segments.length} sentences
              </p>
              <p className="text-sm text-slate-600">
                Press the button below to start. The video will play each sentence one at a time and pause so you can type what you heard.
              </p>
              <div className="flex items-center gap-3 mt-1">
                {resumeState ? (
                  <>
                    <button
                      onClick={handleResume}
                      className="px-6 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700 transition-colors"
                    >
                      ▶ Resume at sentence {resumeState.currentSegmentIndex + 1}
                    </button>
                    <button
                      onClick={handleRestart}
                      className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 font-semibold text-sm hover:bg-slate-50 transition-colors"
                    >
                      Restart
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleStart}
                    className="px-6 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700 transition-colors"
                  >
                    ▶ Start Dictation
                  </button>
                )}
                <button
                  onClick={handleRegenerate}
                  disabled={isRegenerating}
                  title="Re-fetch captions from YouTube to fix sentence/audio mismatches"
                  aria-label={isRegenerating ? "Regenerating transcript…" : "Regenerate transcript"}
                  className="text-xs text-slate-500 hover:text-amber-600 disabled:opacity-50 transition-colors underline"
                >
                  {isRegenerating ? "⏳ Regenerating…" : "🔄 Regenerate transcript"}
                </button>
              </div>
              {resumeLoading && (
                <p className="text-xs text-slate-500">Checking for saved progress…</p>
              )}
            </div>
          )}

          {uxState === "session_completed" && (
            <div className="rounded-xl border border-indigo-300 bg-indigo-50 p-6 flex flex-col gap-4">
              <div className="text-center">
                <p className="text-3xl">🎉</p>
                <p className="text-indigo-700 font-bold text-xl">Session Complete!</p>
                <p className="text-slate-600 text-sm mt-1">
                  Final accuracy: <span className="font-bold">{accuracy}%</span> over{" "}
                  {sessionStore.totalAttempts} attempts.
                </p>
              </div>

              {/* Mistakes review */}
              {mistakes.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <p className="text-slate-700 font-semibold text-sm">
                    Mistakes ({mistakes.length} sentence{mistakes.length !== 1 ? "s" : ""}):
                  </p>
                  <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                    {mistakes.map((m) => (
                      <div
                        key={m.segIdx}
                        className="bg-white rounded-lg border border-slate-200 p-3 flex flex-col gap-1"
                      >
                        <span className="text-xs text-slate-400 font-medium">
                          Sentence {m.segIdx + 1}
                        </span>
                        <span className="text-sm text-slate-800">{m.expectedText}</span>
                        <span className="text-xs text-red-500">
                          You typed:{" "}
                          {m.userText || <span className="italic text-slate-400">nothing</span>}
                        </span>
                        <VocabularySaveButton
                          videoId={videoId}
                          segmentIndex={m.segIdx}
                          sentenceContext={m.expectedText}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-emerald-600 text-sm font-medium text-center">
                  🏆 Perfect session — no mistakes!
                </p>
              )}

              <Link
                href="/"
                className="mt-2 inline-block rounded-xl bg-indigo-600 text-white px-6 py-2 font-semibold hover:bg-indigo-700 transition-colors text-center"
              >
                Try another video
              </Link>
            </div>
          )}

          {/* Dictation input area — below video and controls */}
          {shouldShowInput && (
            <div className="flex flex-col gap-4">
              <DictationInput
                key={`${currentSegIdx}`}
                isEnabled={uxState === "paused_waiting_input" || uxState === "playing"}
                onSubmit={handleAnswerSubmit}
                diff={checkResult?.diff}
                isCorrect={checkResult?.isCorrect ?? null}
                wrongAttempts={wrongAttempts}
                focusSignal={inputFocusSignal}
                inputAriaDescribedBy="dictation-shortcuts-hint"
              />
              <p id="dictation-shortcuts-hint" className="text-[11px] text-slate-500">
                Shortcuts: Replay <span className="font-medium">Shift+Space</span>, Previous{" "}
                <span className="font-medium">Shift+←</span>, Next{" "}
                <span className="font-medium">Shift+→</span> (available while typing).
              </p>

              {/* Review previous completed sentence only after advancing */}
              {shouldShowPreviousReview && previousReview && (
                <div className="rounded-xl border border-slate-200 bg-white p-3 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Review previous sentence
                    </p>
                    <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      #{previousReview.segmentIndex + 1}
                    </span>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
                    <p className="text-[11px] font-semibold text-slate-500">Correct sentence</p>
                    <p className="mt-0.5 text-sm text-slate-900">{previousReview.expectedText}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-100 p-2 text-xs text-slate-700">
                    <p className="text-[11px] font-semibold text-slate-500">Your answer</p>
                    <p className="mt-0.5 text-sm text-slate-800">{previousReview.firstUserText || "—"}</p>
                  </div>
                  <DiffTokenChips diff={previousReview.diff} strong />
                </div>
              )}

              {/* Hint — only relevant when paused */}
              {(uxState === "paused_waiting_input" || uxState === "checking_answer") &&
                !checkResult?.isCorrect && (
                  <HintDisplay
                    text={currentSegment.text}
                    level={hintLevel}
                    onLevelChange={(l) => setHintLevel(l)}
                  />
                )}

            </div>
          )}
        </div>

        {/* Secondary right panel */}
        <aside
          className={clsx(
            "transition-all duration-300",
            showLearningPanel ? "lg:w-1/3" : "lg:w-14"
          )}
        >
          <div
            className={clsx(
              "rounded-xl border border-slate-200 bg-white lg:sticky lg:top-4 transition-all duration-300",
              showLearningPanel ? "p-4" : "p-2"
            )}
          >
            <div className="flex items-center justify-between">
              {showLearningPanel ? (
                <p className="text-sm font-semibold text-slate-700">Lesson panel</p>
              ) : (
                <span className="sr-only">Lesson panel collapsed. Press button to expand.</span>
              )}
              <button
                onClick={() => setShowLearningPanel((v) => !v)}
                className="h-8 w-8 shrink-0 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors"
                aria-label={showLearningPanel ? "Collapse right panel" : "Expand right panel"}
                title={showLearningPanel ? "Collapse right panel" : "Expand right panel"}
              >
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                  className={clsx("h-4 w-4 mx-auto transition-transform", !showLearningPanel && "rotate-180")}
                >
                  <path d="M12.5 4.5L7.5 10l5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            {showLearningPanel && (
              <div className="mt-3 flex flex-col gap-3">
                <div className="rounded-lg bg-slate-100 p-1 grid grid-cols-2 gap-1">
                  <button
                    onClick={() => setRightPanelTab("saved")}
                    className={clsx(
                      "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                      rightPanelTab === "saved"
                        ? "bg-white text-slate-800 shadow-sm"
                        : "text-slate-500 hover:text-slate-700"
                    )}
                  >
                    Saved
                  </button>
                  <button
                    onClick={() => setRightPanelTab("script")}
                    className={clsx(
                      "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                      rightPanelTab === "script"
                        ? "bg-white text-slate-800 shadow-sm"
                        : "text-slate-500 hover:text-slate-700"
                    )}
                  >
                    Script
                  </button>
                </div>

                {rightPanelTab === "saved" ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-slate-700">
                        Saved items ({lessonSavedInCurrentVideo.length})
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(["all", "word", "phrase", "sentence"] as SavedFilter[]).map((filter) => (
                        <button
                          key={filter}
                          onClick={() => setSavedFilter(filter)}
                          className={clsx(
                            "px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors",
                            savedFilter === filter
                              ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                              : "border-slate-300 text-slate-600 hover:bg-slate-50"
                          )}
                        >
                          {getSavedFilterLabel(filter)}
                        </button>
                      ))}
                    </div>
                    {filteredSavedItems.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        {savedFilter === "all"
                          ? "No saved items yet."
                          : `No ${getSavedFilterLabel(savedFilter).toLowerCase()} saved yet.`}
                      </p>
                    ) : (
                      <LessonSavedItemsList
                        items={filteredSavedItems}
                        compact
                        deletingId={learningDeletingId}
                        onDelete={deleteLessonCapture}
                      />
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Viewing the script may reveal answers.
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Select text to save a word, phrase, or sentence from the current or upcoming sentences.
                    </p>

                    {scriptContextSegments.length === 0 ? (
                      <p className="text-xs text-slate-500">Script is not available yet.</p>
                    ) : (
                      <div
                        ref={scriptTextContainerRef}
                        onMouseUp={handleScriptMouseUp}
                        className="relative max-h-[60vh] overflow-y-auto pr-1 flex flex-col gap-3"
                      >
                        {scriptContextSegments.map((segment) => {
                          const isCurrentScriptSentence = segment.segmentIndex === currentSegIdx;
                          const isNextScriptSentence = segment.segmentIndex === currentSegIdx + 1;
                          const isUpcomingScriptSentence =
                            segment.segmentIndex > currentSegIdx &&
                            segment.segmentIndex <= currentSegIdx + 2;
                          return (
                            <div
                              key={segment.segmentIndex}
                              data-script-segment-index={segment.segmentIndex}
                              className={clsx(
                                "rounded-lg border p-3 transition-colors",
                                isCurrentScriptSentence
                                  ? "border-indigo-300 bg-indigo-50"
                                  : isUpcomingScriptSentence
                                  ? "border-slate-200 bg-slate-50"
                                  : "border-slate-200 bg-slate-50"
                              )}
                            >
                              <p
                                className={clsx(
                                  "text-xs font-semibold mb-1",
                                  isCurrentScriptSentence ? "text-indigo-700" : "text-slate-500"
                                )}
                              >
                                {isCurrentScriptSentence
                                  ? `Current sentence · #${segment.segmentIndex + 1}`
                                  : isNextScriptSentence
                                  ? `Next sentence · #${segment.segmentIndex + 1}`
                                  : `Upcoming sentence · #${segment.segmentIndex + 1}`}
                              </p>
                              <div
                                data-script-segment-index={segment.segmentIndex}
                                className="text-sm leading-7 text-slate-700 select-text"
                              >
                                {segment.text}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {learningError && <p className="text-xs text-red-600">{learningError}</p>}

                    {scriptPopover && (
                      <div
                        ref={scriptPopoverRef}
                        className="fixed z-30 -translate-x-1/2 -translate-y-full rounded-lg border border-slate-200 bg-white shadow-lg p-2 flex flex-wrap gap-1.5"
                        style={{ left: scriptPopover.x, top: scriptPopover.y, maxWidth: `${SCRIPT_POPOVER_MAX_WIDTH_PX}px` }}
                        tabIndex={0}
                        role="dialog"
                        aria-modal="false"
                        aria-label="Script selection actions"
                        aria-describedby="script-selection-actions-help"
                      >
                        <button
                          onClick={() => handleScriptPopoverAction("word")}
                          disabled={scriptPopover.selectedWordCount !== 1 || learningSaving}
                          className="px-2 py-1 text-[11px] rounded border border-slate-300 disabled:opacity-40"
                        >
                          Save word
                        </button>
                        <button
                          onClick={() => handleScriptPopoverAction("phrase")}
                          disabled={scriptPopover.selectedWordCount < 2 || learningSaving}
                          className="px-2 py-1 text-[11px] rounded border border-slate-300 disabled:opacity-40"
                        >
                          Save phrase
                        </button>
                        <button
                          onClick={() => handleScriptPopoverAction("sentence")}
                          disabled={learningSaving}
                          className="px-2 py-1 text-[11px] rounded border border-slate-300"
                        >
                          Save sentence
                        </button>
                        <button
                          onClick={() => handleScriptPopoverAction("explain")}
                          className="px-2 py-1 text-[11px] rounded border border-violet-300 text-violet-700 bg-violet-50"
                        >
                          Explain
                        </button>
                        <button
                          onClick={() => handleScriptPopoverAction("note")}
                          className="px-2 py-1 text-[11px] rounded border border-slate-300"
                        >
                          Add note
                        </button>
                        {scriptPopoverNoteMode && (
                          <div className="w-full pt-1 flex items-center gap-1.5">
                            <input
                              ref={scriptPopoverNoteInputRef}
                              onChange={handleLearningNoteChange}
                              placeholder="Optional note"
                              className="flex-1 min-w-0 rounded border border-slate-300 px-2 py-1 text-[11px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                            />
                            <button
                              onClick={() => setScriptPopoverNoteMode(false)}
                              className="px-2 py-1 text-[11px] rounded border border-slate-300 text-slate-600"
                            >
                              Done
                            </button>
                          </div>
                        )}
                        <span id="script-selection-actions-help" className="sr-only">
                          Actions for selected script text: save word, phrase, sentence, explain, or add note.
                        </span>
                      </div>
                    )}

                    {scriptShowAI && scriptPopover && (
                      <AIExplainer
                        expectedText={scriptAiPayload.expectedText}
                        userText={scriptAiPayload.userText}
                        buttonLabel={scriptAiPayload.buttonLabel}
                        onExplanationReady={setScriptAiReady}
                      />
                    )}
                    {scriptShowAI && scriptAiReady && scriptPopover && (
                      <p className="text-xs text-slate-500">
                        Selection: <span className="font-medium text-slate-700">{scriptPopover.selectedText}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

// ---- Helper component ----

function StatusCard({
  icon,
  title,
  description,
  pulse,
  error,
}: {
  icon: string;
  title: string;
  description: string;
  pulse?: boolean;
  error?: boolean;
}) {
  return (
    <div
      className={clsx(
        "rounded-xl border p-5 flex flex-col gap-2",
        error
          ? "border-red-300 bg-red-50"
          : "border-slate-200 bg-white"
      )}
    >
      <p className={clsx("text-2xl", pulse && "animate-pulse")}>{icon}</p>
      <p className="font-semibold text-slate-800">{title}</p>
      <p className="text-sm text-slate-500">{description}</p>
    </div>
  );
}

function DiffTokenChips({
  diff,
  strong = false,
}: {
  diff: DiffToken[] | undefined;
  strong?: boolean;
}) {
  if (!diff || diff.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {diff.map((token, idx) => (
        <span
          key={`${token.word}-${idx}`}
          className={clsx(
            "px-2 py-0.5 rounded-full text-[11px] border",
            strong && "px-2.5 py-1 text-xs font-semibold",
            token.status === "correct" && "border-emerald-200 bg-emerald-50 text-emerald-700",
            token.status === "wrong" && "border-red-300 bg-red-100 text-red-800",
            token.status === "missing" && "border-amber-300 bg-amber-100 text-amber-800",
            token.status === "extra" && "border-slate-300 bg-slate-100 text-slate-700"
          )}
        >
          {token.word}
        </span>
      ))}
    </div>
  );
}

function LessonSavedItemsList({
  items,
  compact = false,
  deletingId,
  onDelete,
}: {
  items: LessonSavedItem[];
  compact?: boolean;
  deletingId: string | null;
  onDelete: (itemId: string) => void;
}) {
  return (
    <div className={clsx("flex flex-col gap-2 max-h-52 overflow-y-auto pr-1", compact && "pr-0")}>
      {items.map((item) => (
        <div
          key={item.id}
          className={clsx(
            "rounded-lg border border-slate-200 bg-white p-3 flex flex-col gap-1",
            compact && "p-2 rounded-md"
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className={clsx("text-sm text-slate-800", compact && "text-xs font-semibold")}>{item.term}</span>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide rounded-full bg-indigo-100 text-indigo-700 px-2 py-0.5">
                {item.type}
              </span>
              <button
                onClick={() => onDelete(item.id)}
                disabled={deletingId === item.id}
                className="h-5 w-5 rounded-full border border-slate-300 text-slate-500 hover:text-red-600 hover:border-red-300 focus:text-red-600 focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-200 disabled:opacity-40"
                aria-label={
                  deletingId === item.id
                    ? `Removing saved item ${item.term}`
                    : `Remove saved item ${item.term}`
                }
                aria-live="polite"
                title="Remove saved item"
              >
                {deletingId === item.id ? (
                  <svg
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                    className="h-3.5 w-3.5 mx-auto animate-spin"
                  >
                    <circle
                      cx="10"
                      cy="10"
                      r="7"
                      fill="none"
                      stroke="currentColor"
                      strokeOpacity="0.25"
                      strokeWidth="2"
                    />
                    <path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 mx-auto">
                    <path
                      d="M6 6l8 8M14 6l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>
          <span className={clsx("text-xs text-slate-500", compact && "text-[11px]")}>
            Sentence {item.segment_index + 1}
          </span>
          <span className={clsx("text-xs text-slate-600", compact && "text-[11px] line-clamp-2")}>
            {item.sentence_context}
          </span>
          {item.note && (
            <span className={clsx("text-xs text-slate-700", compact && "text-[11px]")}>📝 {item.note}</span>
          )}
        </div>
      ))}
    </div>
  );
}
