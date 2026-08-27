"use client";

import "./player-theme.css";
import { use, useState, useCallback, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import {
  ArrowLeft,
  PanelRightClose,
  PanelRightOpen,
  Check,
  X,
  Bookmark,
  Sparkles,
  Type,
  Quote,
  AlignLeft,
  StickyNote,
  Loader2,
  Volume2,
  Undo2,
  Flame,
  SlidersHorizontal,
  Download,
  Settings,
  Maximize,
  Minimize,
  Columns2,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

import YouTubePlayer from "@/components/YouTubePlayer";
import UserButton from "@/components/UserButton";
import VocabularySaveButton from "@/components/VocabularySaveButton";
import { StatusCard } from "@/components/StatusCard";

import { usePlayerStore } from "@/store/playerStore";
import { useSessionStore, selectAccuracy } from "@/store/sessionStore";
import { useAuth, useRequireAuth } from "@/context/auth";
import { useManualTranscriptPaste } from "./useManualTranscriptPaste";
import { useVideoSizeMode } from "./useVideoSizeMode";
import { useSoundPreference } from "./useSoundPreference";
import { usePlaybackRatePreference } from "./usePlaybackRatePreference";
import { useAutoAdvancePreference } from "./useAutoAdvancePreference";
import { usePracticeModePreference } from "./usePracticeModePreference";
import { useSubtitleVisibilityPreference } from "./useSubtitleVisibilityPreference";
import { useStreak } from "./useStreak";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useLessonCapture } from "./useLessonCapture";
import { useDictationSession } from "./useDictationSession";
import { useScriptTranslation } from "./useScriptTranslation";
import { useVocabHighlights } from "./useVocabHighlights";
import { useBookmarks } from "@/hooks/useBookmarks";
import { playCorrectChime, playComboMilestoneChime } from "@/lib/utils/chime";

import { ConfettiBurst } from "./components/ConfettiBurst";
import { MobileBottomSheet } from "./components/MobileBottomSheet";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { RightPanelTabs } from "./components/RightPanelTabs";
import { DefaultLayout } from "./components/layouts/DefaultLayout";
import {
  SCRIPT_POPOVER_MAX_WIDTH_PX,
  SCRIPT_CONTEXT_NEXT_COUNT,
  SCRIPT_CONTEXT_PREVIOUS_COUNT,
  VIDEO_SIZE_MODE_CLASS,
  COMBO_MILESTONE_INTERVAL,
  PLAYBACK_RATE_OPTIONS,
} from "./constants";
import { checkAnswer as evaluateAutoAdvanceAnswer } from "@/lib/utils/text";
import type { RightPanelTab } from "./types";

// ---- Page component ----

interface PageProps {
  params: Promise<{ videoId: string }>;
}

export default function DictationPage({ params }: PageProps) {
  const { videoId } = use(params);
  const { user } = useAuth();
  const requireAuth = useRequireAuth();

  // Stores
  const playerStore = usePlayerStore();
  const sessionStore = useSessionStore();
  const accuracy = selectAccuracy(sessionStore);
  // Local state
  const [showLearningPanel, setShowLearningPanel] = useState(true);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("script");
  const [showPreviousScriptContext, setShowPreviousScriptContext] = useState(false);
  const [showScriptContext, setShowScriptContext] = useState(true);
  const [showVideo, setShowVideo] = useState(true);
  const [workspaceInputValue, setWorkspaceInputValue] = useState("");
  const [isZenMode, setIsZenMode] = useState(false);
  const [showHintPanel, setShowHintPanel] = useState(false);
  const [bookmarkDeletingId, setBookmarkDeletingId] = useState<string | null>(null);
  const [showMoreSettings, setShowMoreSettings] = useState(false);
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const { videoSizeMode, setVideoSizeMode } = useVideoSizeMode();
  const { soundEnabled, setSoundEnabled } = useSoundPreference();
  const { playbackRate, setPlaybackRate } = usePlaybackRatePreference();
  const { autoAdvance, setAutoAdvance } = useAutoAdvancePreference();
  const { practiceMode, setPracticeMode } = usePracticeModePreference();
  const { subtitleVisibility, setOriginalVisibility, setTranslationVisibility } = useSubtitleVisibilityPreference();
  const { streakDays } = useStreak(user);

  const workspaceInputRef = useRef<HTMLInputElement>(null);
  const maskOverlayRef = useRef<HTMLDivElement>(null);
  const previousShowVideoRef = useRef(showVideo);

  const {
    currentSegIdx,
    uxState,
    checkResult,
    setCheckResult,
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
    transcriptTitle,
    ytPlayerRef,
    handleSegmentEnd,
    handleAnswerSubmit,
    handleStart,
    handleReplay,
    handleSkip,
    handlePrevious,
    handleResume,
    handleRestart,
    handleManualTranscriptSaved,
    handleRegenerateTranscript,
    jumpToSegment,
  } = useDictationSession({ videoId, user });

  const {
    bookmarkedSegmentIndexes,
    bookmarks,
    loading: bookmarksLoading,
    error: bookmarksError,
    errorRetry: bookmarksErrorRetry,
    toggleBookmark,
    deleteBookmark,
    updateBookmarkNote,
  } = useBookmarks(videoId, user);

  const {
    showTranslation: showScriptTranslation,
    setShowTranslation: setShowScriptTranslation,
    translationBySegmentIndex,
    translationLoading: scriptTranslationLoading,
    translationError: scriptTranslationError,
    regenerateTranslation,
    regeneratingTranslation,
    regenerateTranslationError,
  } = useScriptTranslation({
    videoId,
    transcriptId: segments[0]?.transcript_id,
    enabled: true,
    wantTranslation: subtitleVisibility.translation !== "hide",
  });

  const { phrasesBySegmentIndex, highlightsError: vocabHighlightsError } = useVocabHighlights({
    videoId,
    transcriptId: segments[0]?.transcript_id,
    enabled: rightPanelTab === "script",
  });

  // ---- Deep-link jump: "?segment=" opens the video directly at a bookmarked
  // sentence. Resume-from-last-position takes priority if both apply, and we
  // wait for the resume check to finish first to avoid racing it.
  const segmentJumpAppliedRef = useRef(false);
  useEffect(() => {
    if (segmentJumpAppliedRef.current) return;
    if (resumeLoading || resumeState) return;
    if (uxState !== "transcript_ready" && uxState !== "paused_waiting_input" && uxState !== "playing") return;
    if (segments.length === 0) return;
    const segmentParam = new URLSearchParams(window.location.search).get("segment");
    if (!segmentParam) return;
    const segIdx = Number(segmentParam);
    if (!Number.isInteger(segIdx) || segIdx < 0 || segIdx >= segments.length) return;
    segmentJumpAppliedRef.current = true;
    jumpToSegment(segIdx);
  }, [resumeLoading, resumeState, uxState, segments.length, jumpToSegment]);

  const handleRegenerateClick = useCallback(() => {
    if (regenerating) return;
    const confirmed = window.confirm(
      "Regenerate this video's script from YouTube's captions? The current script and your progress in this session will be replaced."
    );
    if (!confirmed) return;
    void handleRegenerateTranscript();
  }, [regenerating, handleRegenerateTranscript]);

  const handleWorkspaceCheck = useCallback(() => {
    const trimmed = workspaceInputValue.trim();
    if (!trimmed) return;
    void handleAnswerSubmit(trimmed);
  }, [handleAnswerSubmit, workspaceInputValue]);

  const handleWorkspaceInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleWorkspaceCheck();
      }
    },
    [handleWorkspaceCheck]
  );

  // ---- Keyboard shortcuts ----
  const { inputFocusSignal } = useKeyboardShortcuts({
    onReplay: handleReplay,
    onPrevious: handlePrevious,
    onSkip: handleSkip,
    isZenMode,
    onZenModeChange: setIsZenMode,
  });

  // ---- Manual transcript paste fallback (used when captions aren't available) ----
  const {
    manualPasteText,
    setManualPasteText,
    manualPasteSubmitting,
    manualPasteError,
    handleManualTranscriptSubmit,
  } = useManualTranscriptPaste({
    videoId,
    onTranscriptSaved: handleManualTranscriptSaved,
  });

  const currentSegment = segments[currentSegIdx];

  // Auto-advance: as soon as the typed text exactly matches the sentence
  // (post-normalization), submit automatically instead of waiting for
  // Enter/Check — lets confident typists skip the manual submit step.
  const handleWorkspaceInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setWorkspaceInputValue(value);
      setCheckResult(null);

      if (!autoAdvance || !currentSegment) return;
      if (uxState !== "paused_waiting_input" && uxState !== "playing") return;
      const trimmed = value.trim();
      if (!trimmed) return;
      if (evaluateAutoAdvanceAnswer(currentSegment.text, trimmed, "relaxed").isCorrect) {
        void handleAnswerSubmit(trimmed);
      }
    },
    [autoAdvance, currentSegment, uxState, handleAnswerSubmit, setCheckResult]
  );

  const handleToggleCurrentBookmark = useCallback(() => {
    if (!currentSegment) return;
    requireAuth(() => {
      void toggleBookmark(currentSegment.segmentIndex, currentSegment.start, currentSegment.text).catch(() => {});
    });
  }, [currentSegment, requireAuth, toggleBookmark]);

  const handleBookmarkJump = useCallback(
    (segmentIndex: number) => {
      jumpToSegment(segmentIndex);
    },
    [jumpToSegment]
  );

  const handleDownloadTranscript = useCallback(() => {
    if (segments.length === 0) return;
    const text = segments.map((segment) => segment.text).join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(transcriptTitle ?? `video-${videoId}`).replace(/[^\w.-]+/g, "_")}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [segments, transcriptTitle, videoId]);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  // Derived flag: show dictation input during playback and while paused/checking
  const shouldShowInput =
    (uxState === "paused_waiting_input" ||
      uxState === "checking_answer" ||
      uxState === "playing") &&
    !!currentSegment;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWorkspaceInputValue("");
    setShowHintPanel(false);
  }, [currentSegIdx]);

  useEffect(() => {
    if (!shouldShowInput) return;
    const t = window.setTimeout(() => workspaceInputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [inputFocusSignal, shouldShowInput]);

  // Lets the user swipe horizontally to pan overflowed text instead of only
  // dragging the caret. A short tap still falls through to native cursor
  // placement; only a clear horizontal drag hijacks the gesture.
  useEffect(() => {
    const el = workspaceInputRef.current;
    if (!el || !shouldShowInput) return;

    const DRAG_THRESHOLD = 8;
    let startX = 0;
    let startScrollLeft = 0;
    let isDragging = false;

    const handleTouchStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startScrollLeft = el.scrollLeft;
      isDragging = false;
    };

    const handleTouchMove = (e: TouchEvent) => {
      const deltaX = e.touches[0].clientX - startX;
      if (!isDragging && Math.abs(deltaX) < DRAG_THRESHOLD) return;
      isDragging = true;
      e.preventDefault();
      el.scrollLeft = startScrollLeft - deltaX;
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (isDragging) e.preventDefault();
      isDragging = false;
    };

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd);

    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
    };
  }, [shouldShowInput]);

  const shouldShowPreviousReview =
    !!previousReview &&
    previousReview.segmentIndex === currentSegIdx - 1 &&
    uxState !== "session_completed";
  const scriptContextStartIndex = showPreviousScriptContext
    ? Math.max(0, currentSegIdx - SCRIPT_CONTEXT_PREVIOUS_COUNT)
    : currentSegIdx;
  const scriptContextSegments = useMemo(
    () =>
      segments.filter(
        (segment) =>
          segment.segmentIndex >= scriptContextStartIndex &&
          segment.segmentIndex <= currentSegIdx + SCRIPT_CONTEXT_NEXT_COUNT
      ),
    [currentSegIdx, scriptContextStartIndex, segments]
  );
  const shouldRenderVideoPlayer =
    uxState !== "loading_transcript" &&
    uxState !== "transcript_processing" &&
    uxState !== "transcript_failed";
  // Zen mode is meant to be immersive, so it always shows the video at its
  // largest size regardless of the user's saved Standard/Large preference.
  const effectiveVideoSizeMode = isZenMode ? "large" : videoSizeMode;
  const videoBlock = shouldRenderVideoPlayer && (
    <div className={clsx("mx-auto flex h-full w-full transition-all duration-300", VIDEO_SIZE_MODE_CLASS[effectiveVideoSizeMode])}>
      <div className="h-full w-full">
        <YouTubePlayer
          ref={ytPlayerRef}
          videoId={videoId}
          segments={segments}
          onSegmentEnd={handleSegmentEnd}
        />
      </div>
    </div>
  );

  const {
    learningError,
    learningErrorRetry,
    learningSaving,
    learningDeletingId,
    learningUpdatingId,
    lessonSavedInCurrentVideo,
    scriptPopover,
    scriptPopoverNoteMode,
    setScriptPopoverNoteMode,
    scriptPopoverNoteInputRef,
    scriptTextContainerRef,
    reviewTextContainerRef,
    scriptPopoverRef,
    handleLearningNoteChange,
    pendingDeleteItem,
    requestDeleteLessonCapture,
    undoDeleteLessonCapture,
    updateLessonCapture,
    handleScriptMouseUp,
    handleReviewMouseUp,
    handleScriptWordMouseUp,
    handleScriptPopoverAction,
    phraseHoverPreview,
    handlePhraseMouseEnter,
    handlePhraseMouseLeave,
    handlePhraseTap,
    scriptPopoverPreview,
    scriptPopoverPreviewLoading,
    scriptPopoverPreviewError,
    scriptPopoverSavedItem,
    scriptPopoverSavedFeedback,
    scriptSelectedType,
  } = useLessonCapture({
    videoId,
    user,
    requireAuth,
    segments,
    currentSegIdx,
    currentSegmentText: currentSegment?.text,
    showScriptContext,
    phrasesBySegmentIndex,
    onAfterSave: () => setShowLearningPanel(true),
  });

  const wordItems = useMemo(
    () => lessonSavedInCurrentVideo.filter((item) => item.type === "word" || item.type === "phrase"),
    [lessonSavedInCurrentVideo]
  );
  const sentenceItems = useMemo(
    () => lessonSavedInCurrentVideo.filter((item) => item.type === "sentence"),
    [lessonSavedInCurrentVideo]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowPreviousScriptContext(false);
    setShowScriptContext(true);
  }, [videoId]);

  useEffect(() => {
    const wasShowingVideo = previousShowVideoRef.current;
    if (!wasShowingVideo && showVideo) {
      ytPlayerRef.current?.seekTo(playerStore.currentTimeSec, uxState === "playing");
    }
    previousShowVideoRef.current = showVideo;
  }, [showVideo, playerStore.currentTimeSec, uxState, ytPlayerRef]);

  useEffect(() => {
    ytPlayerRef.current?.setPlaybackRate(playbackRate);
  }, [playbackRate, ytPlayerRef]);

  useEffect(() => {
    if (!showLearningPanel || rightPanelTab !== "script") return;
    const container = scriptTextContainerRef.current;
    if (!container) return;
    const currentCard = container.querySelector<HTMLElement>(
      `[data-script-segment-index="${currentSegIdx}"]`
    );
    currentCard?.scrollIntoView({ block: "nearest" });
  }, [currentSegIdx, rightPanelTab, showLearningPanel, scriptTextContainerRef]);

  const workspaceTitle = transcriptTitle ?? `Video ${videoId}`;

  const isCheckingWorkspace = uxState === "checking_answer" && checkResult === null;
  const workspaceStatus: "idle" | "success" | "error" = checkResult
    ? checkResult.isCorrect
      ? "success"
      : "error"
    : "idle";

  // Play a confirmation chime on each correct answer (a brighter tone on combo milestones).
  // Fires once per successful check result (a fresh object each time), not on every render.
  useEffect(() => {
    if (!checkResult?.isCorrect || !soundEnabled) return;
    if (combo > 0 && combo % COMBO_MILESTONE_INTERVAL === 0) {
      playComboMilestoneChime();
    } else {
      playCorrectChime();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkResult]);

  // ---- Render ----
  return (
    <div className="player-dark-theme relative h-dvh overflow-hidden flex flex-col w-full bg-[var(--bg)] font-sans text-[var(--text)] antialiased">
      <AnimatePresence>
        {isZenMode && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="absolute inset-0 bg-black/70 backdrop-blur-2xl z-0 pointer-events-none"
          />
        )}
      </AnimatePresence>

      <AnimatePresence mode="popLayout">
        {!isZenMode && (
          <motion.header
            initial={{ y: -64, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -64, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="sticky top-0 z-10 w-full border-b border-[var(--border)] bg-[var(--surface)]/80 px-4 py-1 backdrop-blur-md"
          >
            <div className="mx-auto flex w-full max-w-none items-center justify-between">
              <div className="flex min-w-0 items-center gap-4">
                <Link href="/" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-white/10" aria-label="Back to dashboard">
                  <ArrowLeft size={18} />
                </Link>
                <div className="min-w-0">
                  <h1 className="truncate text-sm font-semibold leading-tight text-[var(--text)]">{workspaceTitle}</h1>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2 sm:gap-3">
                {user && streakDays > 0 && (
                  <div className="flex items-center gap-1 rounded-lg bg-[var(--accent-soft)] border border-[var(--accent-border)] px-2 py-1 text-[var(--accent)] sm:gap-1.5 sm:px-2.5">
                    <Flame size={14} className="fill-[var(--accent)]/30" />
                    <span className="text-xs font-semibold sm:hidden">{streakDays}</span>
                    <span className="hidden text-xs font-semibold sm:inline">{streakDays} day streak</span>
                  </div>
                )}
                <div className="hidden h-6 w-px bg-[var(--border)] sm:block" />
                <button
                  onClick={handleDownloadTranscript}
                  disabled={segments.length === 0}
                  className="hidden h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 sm:flex"
                  title="Download transcript"
                  aria-label="Download transcript"
                >
                  <Download size={15} />
                </button>
                <button
                  onClick={handleToggleCurrentBookmark}
                  disabled={!currentSegment}
                  className={clsx(
                    "hidden h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:flex",
                    currentSegment && bookmarkedSegmentIndexes.has(currentSegIdx)
                      ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] hover:bg-white/10"
                  )}
                  title="Bookmark this sentence"
                  aria-label="Bookmark this sentence"
                >
                  <Bookmark size={15} className={currentSegment && bookmarkedSegmentIndexes.has(currentSegIdx) ? "fill-[var(--accent)]" : undefined} />
                </button>
                <button
                  onClick={() => setShowSettingsDrawer(true)}
                  className="hidden h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] transition-colors hover:bg-white/10 sm:flex"
                  title="Settings"
                  aria-label="Open settings"
                >
                  <Settings size={15} />
                </button>
                <button
                  onClick={handleToggleFullscreen}
                  className="hidden h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] transition-colors hover:bg-white/10 sm:flex"
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                  aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                >
                  {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
                </button>
                <button
                  onClick={() => setShowLearningPanel((prev) => !prev)}
                  className={clsx(
                    "hidden h-8 w-8 items-center justify-center rounded-lg border transition-colors sm:flex",
                    showLearningPanel
                      ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] hover:bg-white/10"
                  )}
                  title="Toggle split view"
                  aria-label="Toggle lesson panel split view"
                >
                  <Columns2 size={15} />
                </button>
                <UserButton />
              </div>
            </div>
          </motion.header>
        )}
      </AnimatePresence>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col overflow-y-auto px-4 gap-4 lg:flex-row lg:overflow-hidden">
        <motion.div
          layout
          transition={{ type: "tween", ease: "easeInOut", duration: 0.3 }}
          className={clsx(
            "flex flex-col lg:min-h-0 lg:flex-1 lg:overflow-hidden",
            isZenMode && "z-50"
          )}
        >
          <div className="flex-shrink-0 space-y-2 pt-2">
          <AnimatePresence initial={false}>
            {!isZenMode && (
              <motion.div
                key="video-toolbar"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
                className="overflow-hidden"
              >
                {/* Phone-only compact row: the most-used controls stay one tap away,
                    the rest move into the "More settings" sheet below. */}
                <div className="flex sm:hidden items-center gap-2">
                  <button
                    onClick={() => setIsZenMode(true)}
                    aria-label="Zen Mode"
                    title="Zen Mode"
                    className="h-11 w-11 flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] active:scale-95 transition-all"
                  >
                    <Sparkles size={18} className="text-[var(--accent)]" />
                  </button>
                  <button
                    onClick={() => setShowVideo((v) => !v)}
                    aria-label={showVideo ? "Enable Audio Mode" : "Exit Audio Mode"}
                    aria-pressed={!showVideo}
                    title={showVideo ? "Audio Mode" : "Exit Audio Mode"}
                    className={clsx(
                      "h-11 w-11 flex items-center justify-center rounded-xl border transition-all active:scale-95",
                      !showVideo
                        ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)]"
                    )}
                  >
                    <Sparkles size={18} />
                  </button>
                  <button
                    onClick={() =>
                      setPlaybackRate(
                        PLAYBACK_RATE_OPTIONS[
                          (PLAYBACK_RATE_OPTIONS.indexOf(playbackRate) + 1) % PLAYBACK_RATE_OPTIONS.length
                        ]
                      )
                    }
                    aria-label={`Playback speed: ${playbackRate}x, tap to change`}
                    className="h-11 min-w-11 px-2 flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-glass)] text-xs font-bold text-[var(--text-muted)] active:scale-95 transition-all"
                  >
                    {playbackRate}x
                  </button>
                  <button
                    onClick={() => setShowMoreSettings(true)}
                    aria-label="More settings"
                    title="More settings"
                    className="h-11 w-11 flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] active:scale-95 transition-all"
                  >
                    <SlidersHorizontal size={18} />
                  </button>
                </div>

              </motion.div>
            )}
          </AnimatePresence>

          <SettingsDrawer
            open={showSettingsDrawer}
            onClose={() => setShowSettingsDrawer(false)}
            showVideo={showVideo}
            onToggleAudioMode={() => setShowVideo((v) => !v)}
            onActivateZenMode={() => {
              setIsZenMode(true);
              setShowSettingsDrawer(false);
            }}
            videoSizeMode={videoSizeMode}
            setVideoSizeMode={setVideoSizeMode}
            playbackRate={playbackRate}
            setPlaybackRate={setPlaybackRate}
            autoAdvance={autoAdvance}
            setAutoAdvance={setAutoAdvance}
            practiceMode={practiceMode}
            setPracticeMode={setPracticeMode}
          />

          <MobileBottomSheet open={showMoreSettings} onClose={() => setShowMoreSettings(false)} title="More settings">
            <div className="flex flex-col gap-4">
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Video size</p>
                <div className="flex items-center rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1 shadow-sm">
                  <button
                    onClick={() => setVideoSizeMode("standard")}
                    className={clsx(
                      "flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors",
                      videoSizeMode === "standard" ? "bg-[var(--accent)] text-[#1a1206]" : "text-[var(--text-muted)]"
                    )}
                  >
                    Standard
                  </button>
                  <button
                    onClick={() => setVideoSizeMode("large")}
                    className={clsx(
                      "flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors",
                      videoSizeMode === "large" ? "bg-[var(--accent)] text-[#1a1206]" : "text-[var(--text-muted)]"
                    )}
                  >
                    Large
                  </button>
                </div>
              </div>

              <button
                onClick={() => setAutoAdvance((v) => !v)}
                className={clsx(
                  "flex items-center justify-between rounded-xl border px-4 py-3 text-sm font-semibold transition-colors",
                  autoAdvance
                    ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)]"
                )}
              >
                <span className="flex items-center gap-2">
                  <Sparkles size={16} className="text-[var(--accent)]" />
                  Auto-advance
                </span>
                <span>{autoAdvance ? "On" : "Off"}</span>
              </button>

              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Practice mode</p>
                <div
                  className="flex items-center rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1 shadow-sm"
                  title="Easy mode always shows the sentence's word/letter shape. Hard mode hides it until you ask for a hint."
                >
                  <button
                    onClick={() => setPracticeMode("easy")}
                    className={clsx(
                      "flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors",
                      practiceMode === "easy" ? "bg-[var(--accent)] text-[#1a1206]" : "text-[var(--text-muted)]"
                    )}
                  >
                    Easy
                  </button>
                  <button
                    onClick={() => setPracticeMode("hard")}
                    className={clsx(
                      "flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors",
                      practiceMode === "hard" ? "bg-[var(--accent)] text-[#1a1206]" : "text-[var(--text-muted)]"
                    )}
                  >
                    Hard
                  </button>
                </div>
              </div>
            </div>
          </MobileBottomSheet>

          <DefaultLayout
            videoId={videoId}
            isZenMode={isZenMode}
            showVideo={showVideo}
            videoBlock={videoBlock}
            uxState={uxState}
            currentSegIdx={currentSegIdx}
            totalSegments={segments.length}
            onReset={() => {
              setWorkspaceInputValue("");
              setCheckResult(null);
              setShowHintPanel(false);
            }}
            onPrevious={handlePrevious}
            onReplay={handleReplay}
            onNext={handleSkip}
            currentSegment={currentSegment}
            soundEnabled={soundEnabled}
            onToggleSound={() => setSoundEnabled(!soundEnabled)}
            combo={combo}
            subtitleVisibility={subtitleVisibility}
            setOriginalVisibility={setOriginalVisibility}
            setTranslationVisibility={setTranslationVisibility}
            workspaceInputRef={workspaceInputRef}
            maskOverlayRef={maskOverlayRef}
            workspaceInputValue={workspaceInputValue}
            onWorkspaceInputChange={handleWorkspaceInputChange}
            onWorkspaceInputKeyDown={handleWorkspaceInputKeyDown}
            onWorkspaceCheck={handleWorkspaceCheck}
            practiceMode={practiceMode}
            workspaceStatus={workspaceStatus}
            isCheckingWorkspace={isCheckingWorkspace}
            isLastResultClean={isLastResultClean}
            onDismissCheckResult={() => setCheckResult(null)}
            checkAnswerError={checkAnswerError}
            checkResult={checkResult}
            showHintPanel={showHintPanel}
            onToggleHintPanel={() => setShowHintPanel((prev) => !prev)}
            hintLevel={hintLevel}
            onHintLevelChange={(l) => setHintLevel(l)}
            shouldShowPreviousReview={shouldShowPreviousReview}
            previousReview={previousReview}
            reviewTextContainerRef={reviewTextContainerRef}
            handleReviewMouseUp={handleReviewMouseUp}
            accuracy={accuracy}
            translationText={translationBySegmentIndex.get(currentSegIdx)}
          />
          </div>

          <div className="py-3 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
          <div className="bg-[var(--surface)] backdrop-blur-xl border border-[var(--border)] rounded-3xl p-4 flex flex-col gap-3 shadow-xl transition-all duration-300 ease-out text-[var(--text)]">

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
              <div role="alert" className="rounded-xl border border-[var(--red)]/40 bg-[var(--red)]/10 backdrop-blur-md p-5 flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <p className="text-2xl" aria-hidden="true">❌</p>
                  <p className="font-semibold text-[var(--text)]">Transcript failed</p>
                  <p className="text-sm text-[var(--text-muted)]">
                    Could not automatically fetch captions for this video. You can paste the
                    transcript yourself below to continue — sentence timing will be estimated,
                    so use Replay to resync as needed.
                  </p>
                </div>
                <textarea
                  value={manualPasteText}
                  onChange={(e) => setManualPasteText(e.target.value)}
                  placeholder="Paste the video's transcript here, as plain sentences..."
                  rows={6}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-soft)]"
                />
                {manualPasteError && (
                  <p className="text-sm text-[var(--red)]">{manualPasteError}</p>
                )}
                <div>
                  <button
                    onClick={handleManualTranscriptSubmit}
                    disabled={manualPasteSubmitting || manualPasteText.trim().length === 0}
                    className="px-5 py-2 rounded-xl bg-[var(--accent)] text-[#1a1206] font-semibold text-sm hover:brightness-110 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {manualPasteSubmitting ? "Saving..." : "Use this transcript"}
                  </button>
                </div>
              </div>
            )}

            {uxState === "transcript_ready" && segments.length > 0 && (
              <div className="rounded-xl border border-[var(--green)]/40 bg-[var(--green)]/10 backdrop-blur-md p-4 flex flex-col gap-3 mb-4">
                <p className="text-[var(--green)] font-semibold">Transcript ready - {segments.length} sentences</p>
                {resumeState?.status === "completed" ? (
                  <>
                    <p className="text-sm text-[var(--text-muted)]">
                      You already completed this video with{" "}
                      <span className="font-semibold">{resumeState.accuracy}% accuracy</span> over{" "}
                      {resumeState.totalAttempts} attempts.
                    </p>
                    <div className="flex items-center gap-3 mt-1">
                      <Link
                        href={`/results/${resumeState.sessionId}`}
                        className="px-6 py-2 rounded-xl bg-[var(--accent)] text-[#1a1206] font-semibold text-sm hover:brightness-110 transition-colors"
                      >
                        View Results
                      </Link>
                      <button onClick={handleRestart} className="px-4 py-2 rounded-xl border border-[var(--border)] text-[var(--text)] font-semibold text-sm hover:bg-white/10 transition-colors">
                        Practice Again
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-[var(--text-muted)]">Press the button below to start. The video will play each sentence one at a time and pause so you can type what you heard.</p>
                    <div className="flex items-center gap-3 mt-1">
                      {resumeState ? (
                        <>
                          <button onClick={handleResume} className="px-6 py-2 rounded-xl bg-[var(--accent)] text-[#1a1206] font-semibold text-sm hover:brightness-110 transition-colors">
                            Resume at sentence {resumeState.currentSegmentIndex + 1}
                          </button>
                          <button onClick={handleRestart} className="px-4 py-2 rounded-xl border border-[var(--border)] text-[var(--text)] font-semibold text-sm hover:bg-white/10 transition-colors">
                            Restart
                          </button>
                        </>
                      ) : (
                        <button onClick={handleStart} className="px-6 py-2 rounded-xl bg-[var(--accent)] text-[#1a1206] font-semibold text-sm hover:brightness-110 transition-colors">
                          Start Dictation
                        </button>
                      )}
                    </div>
                  </>
                )}
                {resumeLoading && <p className="text-xs text-[var(--text-muted)]">Checking for saved progress...</p>}
              </div>
            )}

            <AnimatePresence>
              {isZenMode && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 20 }}
                  transition={{ duration: 0.3, delay: 0.15, ease: "easeOut" }}
                  className="mt-8 flex justify-center"
                >
                  <button onClick={() => setIsZenMode(false)} className="group flex flex-col items-center gap-2">
                    <div className="w-12 h-12 rounded-full bg-white/10 border border-white/20 backdrop-blur-md flex items-center justify-center text-white/50 group-hover:text-white group-hover:bg-white/20 transition-all group-hover:scale-110">
                      <X size={24} />
                    </div>
                    <span className="text-[10px] uppercase font-black tracking-widest text-white/30 group-hover:text-white/60 transition-colors">Exit Zen Mode (Esc)</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {uxState === "session_completed" && (
              <div className="relative overflow-hidden rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)] backdrop-blur-md p-6 flex flex-col gap-4 mt-6">
                {(mistakes.length === 0 || (previousRunSnapshot && accuracy > previousRunSnapshot.accuracy)) && (
                  <ConfettiBurst />
                )}
                <div className="text-center">
                  <p className="text-3xl">🎉</p>
                  <p className="text-[var(--accent)] font-bold text-xl">Session Complete!</p>
                  <p className="text-[var(--text-muted)] text-sm mt-1">Final accuracy: <span className="font-bold text-[var(--text)]">{accuracy}%</span> over {sessionStore.totalAttempts} attempts.</p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs font-semibold">
                    {bestCombo > 1 && (
                      <span className="rounded-full bg-[var(--red)]/15 px-3 py-1 text-[var(--red)]">
                        🔥 Best streak: {bestCombo} in a row
                      </span>
                    )}
                    <span className="rounded-full bg-[var(--accent)]/20 px-3 py-1 text-[var(--accent)]">
                      ⚡ {cleanSolveCount}/{segments.length} sentences on the first try
                    </span>
                    {previousRunSnapshot && (
                      <span
                        className={clsx(
                          "rounded-full px-3 py-1",
                          accuracy > previousRunSnapshot.accuracy
                            ? "bg-[var(--green)]/20 text-[var(--green)]"
                            : "bg-[var(--surface-2)] text-[var(--text-muted)]"
                        )}
                      >
                        {accuracy > previousRunSnapshot.accuracy
                          ? `+${accuracy - previousRunSnapshot.accuracy}%`
                          : accuracy < previousRunSnapshot.accuracy
                          ? `${accuracy - previousRunSnapshot.accuracy}%`
                          : "Same as"}{" "}
                        vs your last run ({previousRunSnapshot.accuracy}%)
                      </span>
                    )}
                  </div>
                </div>
                {mistakes.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-[var(--text)] font-semibold text-sm">Mistakes ({mistakes.length} sentence{mistakes.length !== 1 ? "s" : ""}):</p>
                    <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                      {mistakes.map((m) => (
                        <div key={m.segIdx} className="bg-[var(--surface-2)] backdrop-blur-md rounded-lg border border-[var(--border)] p-3 flex flex-col gap-1">
                          <span className="text-xs text-[var(--text-faint)] font-medium">Sentence {m.segIdx + 1}</span>
                          <span className="text-sm text-[var(--text)]">{m.expectedText}</span>
                          <span className="text-xs text-[var(--red)]">You typed: {m.userText || <span className="italic text-[var(--text-faint)]">nothing</span>}</span>
                          <VocabularySaveButton videoId={videoId} segmentIndex={m.segIdx} sentenceContext={m.expectedText} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-[var(--green)] text-sm font-medium text-center">Perfect session - no mistakes!</p>
                )}
                <div className="mt-2 flex items-center justify-center gap-3">
                  {sessionStore.sessionId && (
                    <Link
                      href={`/results/${sessionStore.sessionId}`}
                      className="rounded-xl border border-[var(--accent-border)] text-[var(--accent)] px-6 py-2 font-semibold hover:bg-[var(--accent-soft)] transition-colors text-center"
                    >
                      View full report
                    </Link>
                  )}
                  <Link href="/" className="rounded-xl bg-[var(--accent)] text-[#1a1206] px-6 py-2 font-semibold hover:brightness-110 transition-colors text-center">
                    Try another video
                  </Link>
                </div>
              </div>
            )}
          </div>
          </div>
        </motion.div>

        <AnimatePresence initial={false} mode="popLayout">
          {showLearningPanel && (
            <motion.div
              key="learning-panel"
              initial={isZenMode ? { opacity: 0, x: 24 } : { opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={isZenMode ? { opacity: 0, x: 24 } : { opacity: 0, x: 16 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className={clsx(
                "shrink-0 overflow-hidden",
                isZenMode
                  ? "w-full sm:fixed sm:top-4 sm:right-4 sm:bottom-4 sm:z-[60] sm:w-[360px] sm:max-w-[calc(100vw-2rem)]"
                  : "w-full lg:h-full lg:w-[360px]"
              )}
            >
                <div className="w-full h-full flex flex-col bg-[var(--surface)] backdrop-blur-xl border border-[var(--border-strong)] rounded-3xl shadow-lg overflow-hidden text-[var(--text)]">
              <div className="p-4 border-b border-[var(--border)] bg-[var(--surface-2)]/60 backdrop-blur-md">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <h2 className="font-semibold text-[var(--text)]">Lesson panel</h2>
                  <button
                    onClick={() => setShowLearningPanel(false)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] shadow-sm backdrop-blur-md transition-all hover:bg-white/10"
                    aria-label="Hide lesson panel"
                  >
                    <PanelRightClose size={16} />
                  </button>
                </div>
              </div>
                <RightPanelTabs
                  rightPanelTab={rightPanelTab}
                  setRightPanelTab={setRightPanelTab}
                  scriptContextSegments={scriptContextSegments}
                  currentSegIdx={currentSegIdx}
                  showScriptContext={showScriptContext}
                  setShowScriptContext={setShowScriptContext}
                  showPreviousScriptContext={showPreviousScriptContext}
                  setShowPreviousScriptContext={setShowPreviousScriptContext}
                  showScriptTranslation={showScriptTranslation}
                  setShowScriptTranslation={setShowScriptTranslation}
                  translationBySegmentIndex={translationBySegmentIndex}
                  scriptTranslationLoading={scriptTranslationLoading}
                  scriptTranslationError={scriptTranslationError}
                  regenerateTranslation={() => void regenerateTranslation()}
                  regeneratingTranslation={regeneratingTranslation}
                  regenerateTranslationError={regenerateTranslationError}
                  regenerating={regenerating}
                  regenerateError={regenerateError}
                  onRegenerateScript={handleRegenerateClick}
                  phrasesBySegmentIndex={phrasesBySegmentIndex}
                  vocabHighlightsError={vocabHighlightsError}
                  scriptTextContainerRef={scriptTextContainerRef}
                  handleScriptMouseUp={handleScriptMouseUp}
                  handleScriptWordMouseUp={handleScriptWordMouseUp}
                  handlePhraseMouseEnter={handlePhraseMouseEnter}
                  handlePhraseMouseLeave={handlePhraseMouseLeave}
                  handlePhraseTap={handlePhraseTap}
                  wordItems={wordItems}
                  sentenceItems={sentenceItems}
                  learningError={learningError}
                  learningErrorRetry={learningErrorRetry}
                  learningDeletingId={learningDeletingId}
                  learningUpdatingId={learningUpdatingId}
                  onDeleteLearningItem={requestDeleteLessonCapture}
                  onUpdateLearningItem={updateLessonCapture}
                  bookmarks={bookmarks}
                  bookmarksLoading={bookmarksLoading}
                  bookmarksError={bookmarksError}
                  bookmarksErrorRetry={bookmarksErrorRetry}
                  bookmarkDeletingId={bookmarkDeletingId}
                  onDeleteBookmark={(id) => {
                    setBookmarkDeletingId(id);
                    void deleteBookmark(id)
                      .catch(() => {})
                      .finally(() => setBookmarkDeletingId(null));
                  }}
                  onUpdateBookmarkNote={(id, note) => void updateBookmarkNote(id, note).catch(() => {})}
                  onJumpBookmark={handleBookmarkJump}
                />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

        {!showLearningPanel && (
          <div
            className={clsx(
              isZenMode
                ? "fixed inset-x-0 bottom-4 z-[60] flex justify-center sm:inset-x-auto sm:top-4 sm:right-4 sm:bottom-auto"
                : "flex w-full justify-end lg:w-auto lg:justify-start lg:self-start lg:pt-3"
            )}
          >
            <button
              onClick={() => setShowLearningPanel(true)}
              className={clsx(
                "inline-flex h-10 w-10 items-center justify-center rounded-xl border shadow-sm backdrop-blur-md transition-colors",
                isZenMode
                  ? "border-white/20 bg-white/10 text-white/60 hover:bg-white/20 hover:text-white"
                  : "border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] hover:bg-white/10"
              )}
              aria-label="Show lesson panel"
              title="Show lesson panel"
            >
              <PanelRightOpen size={16} />
            </button>
          </div>
        )}

        <AnimatePresence>
          {scriptPopover && (
            <motion.div
              ref={scriptPopoverRef}
              initial={{ opacity: 0, scale: 0.92, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 4 }}
              transition={{ duration: 0.12 }}
              className="fixed z-[80] -translate-x-1/2 -translate-y-full rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] p-2.5 shadow-xl backdrop-blur-xl flex flex-wrap items-center gap-1.5"
              style={{ left: scriptPopover.x, top: scriptPopover.y, maxWidth: `${SCRIPT_POPOVER_MAX_WIDTH_PX}px` }}
              tabIndex={0}
              role="dialog"
              aria-modal="false"
              aria-label="Script selection actions"
              aria-describedby="script-selection-actions-help"
            >
              {scriptPopoverSavedItem && (
                <div className="flex w-full items-center gap-1 rounded-lg bg-[var(--green)]/15 px-2.5 py-1 text-[11px] font-medium text-[var(--green)]">
                  <Check size={12} /> Already saved as {scriptPopoverSavedItem.type}
                </div>
              )}
              <div className="w-full rounded-xl bg-[var(--surface-2)] px-2.5 py-2">
                {scriptPopoverPreviewLoading ? (
                  <div className="h-3.5 w-24 animate-pulse rounded bg-white/10" />
                ) : scriptPopoverPreview?.wordDetails ? (
                  <div className="flex items-start gap-2">
                    {scriptPopoverPreview.image && (
                      <img
                        src={scriptPopoverPreview.image.thumbnailUrl}
                        alt={scriptPopover.selectedText}
                        className="h-12 w-12 shrink-0 rounded-lg object-cover"
                      />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold text-[var(--text)]">
                          {scriptPopover.selectedText}
                        </span>
                        {scriptPopoverPreview.wordDetails.phonetic && (
                          <span className="text-xs text-[var(--text-muted)]">
                            {scriptPopoverPreview.wordDetails.phonetic}
                          </span>
                        )}
                        {scriptPopoverPreview.wordDetails.audioUrl && (
                          <button
                            type="button"
                            onClick={() => {
                              const audioUrl = scriptPopoverPreview.wordDetails?.audioUrl;
                              if (audioUrl) void new Audio(audioUrl).play().catch(() => {});
                            }}
                            className="text-[var(--text-faint)] transition-colors hover:text-[var(--accent)]"
                            aria-label="Play pronunciation"
                          >
                            <Volume2 size={13} />
                          </button>
                        )}
                        {scriptPopoverPreview.wordDetails.partOfSpeech && (
                          <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                            {scriptPopoverPreview.wordDetails.partOfSpeech}
                          </span>
                        )}
                      </div>
                      {scriptPopoverPreview.wordDetails.definition && (
                        <p className="line-clamp-2 text-xs leading-snug text-[var(--text-muted)]">
                          {scriptPopoverPreview.wordDetails.definition}
                        </p>
                      )}
                      {scriptPopoverPreview.translation && (
                        <p className="text-sm font-medium text-[var(--accent)]">
                          {scriptPopoverPreview.translation.text}
                        </p>
                      )}
                      {scriptPopoverPreview.image && (
                        <a
                          href={scriptPopoverPreview.image.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-[10px] text-[var(--text-faint)] hover:text-[var(--text-muted)]"
                        >
                          {scriptPopoverPreview.image.attribution}
                        </a>
                      )}
                    </div>
                  </div>
                ) : scriptPopoverPreview?.translation ? (
                  <p className="text-sm font-medium text-[var(--accent)]">
                    {scriptPopoverPreview.translation.text}
                  </p>
                ) : null}

                {!scriptPopoverPreviewLoading && scriptPopoverPreviewError && (
                  <p className="text-xs font-medium text-[var(--accent)]">
                    Translation unavailable, try again shortly.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 rounded-xl bg-[var(--surface-2)] p-1">
                {scriptPopoverSavedFeedback ? (
                  <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-[var(--green)]">
                    <Check size={13} />
                    Saved
                  </span>
                ) : learningSaving ? (
                  <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-muted)]">
                    <Loader2 size={13} className="animate-spin" />
                    Saving…
                  </span>
                ) : (
                  <>
                    <button
                      onClick={() => handleScriptPopoverAction("word")}
                      disabled={scriptPopover.selectedWordCount !== 1}
                      className={clsx(
                        "flex items-center gap-1 rounded-lg px-3 py-2.5 sm:px-2.5 sm:py-1.5 text-[11px] font-medium transition-colors disabled:opacity-30 disabled:hover:bg-transparent hover:bg-white/10",
                        scriptSelectedType === "word"
                          ? "bg-white/10 text-[var(--accent)] ring-1 ring-[var(--accent-border)]"
                          : "text-[var(--text-muted)] hover:text-[var(--accent)]"
                      )}
                      title="Save word (W)"
                    >
                      <Type size={13} /> Word
                    </button>
                    <button
                      onClick={() => handleScriptPopoverAction("phrase")}
                      disabled={scriptPopover.selectedWordCount < 2}
                      className={clsx(
                        "flex items-center gap-1 rounded-lg px-3 py-2.5 sm:px-2.5 sm:py-1.5 text-[11px] font-medium transition-colors disabled:opacity-30 disabled:hover:bg-transparent hover:bg-white/10",
                        scriptSelectedType === "phrase"
                          ? "bg-white/10 text-[var(--accent)] ring-1 ring-[var(--accent-border)]"
                          : "text-[var(--text-muted)] hover:text-[var(--accent)]"
                      )}
                      title="Save phrase (P)"
                    >
                      <Quote size={13} /> Phrase
                    </button>
                    <button
                      onClick={() => handleScriptPopoverAction("sentence")}
                      className="flex items-center gap-1 rounded-lg px-3 py-2.5 sm:px-2.5 sm:py-1.5 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:bg-white/10 hover:text-[var(--accent)]"
                      title="Save sentence (S)"
                    >
                      <AlignLeft size={13} /> Sentence
                    </button>
                  </>
                )}
              </div>

              <button
                onClick={() => {
                  const segment = segments.find((s) => s.segmentIndex === scriptPopover.segmentIndex);
                  if (!segment) return;
                  requireAuth(() => {
                    void toggleBookmark(segment.segmentIndex, segment.start, segment.text).catch(() => {});
                  });
                }}
                className={clsx(
                  "flex items-center gap-1 rounded-xl border px-3 py-2.5 sm:px-2.5 sm:py-1.5 text-[11px] font-medium transition-colors",
                  bookmarkedSegmentIndexes.has(scriptPopover.segmentIndex)
                    ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:bg-white/10"
                )}
              >
                <Bookmark size={13} />
                {bookmarkedSegmentIndexes.has(scriptPopover.segmentIndex) ? "Bookmarked" : "Bookmark"}
              </button>

              <button
                onClick={() => handleScriptPopoverAction("note")}
                className="flex items-center gap-1 rounded-xl border border-[var(--border)] px-3 py-2.5 sm:px-2.5 sm:py-1.5 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:bg-white/10"
              >
                <StickyNote size={13} /> Note
              </button>

              {scriptPopoverNoteMode && (
                <div className="flex w-full items-end gap-1.5 pt-1">
                  <textarea
                    ref={scriptPopoverNoteInputRef}
                    onChange={(e) => {
                      handleLearningNoteChange(e);
                      e.target.style.height = "auto";
                      e.target.style.height = `${e.target.scrollHeight}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setScriptPopoverNoteMode(false);
                      }
                    }}
                    placeholder="Optional note (Shift+Enter for new line)"
                    rows={2}
                    className="min-w-0 flex-1 resize-none rounded-lg border border-[var(--border)] bg-white/5 px-2 py-1 text-[11px] leading-snug text-[var(--text)] outline-none focus:border-[var(--accent-border)] focus:ring-2 focus:ring-[var(--accent-soft)]"
                  />
                  <button
                    onClick={() => setScriptPopoverNoteMode(false)}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)]"
                  >
                    <Check size={13} />
                  </button>
                </div>
              )}
              <span id="script-selection-actions-help" className="sr-only">
                Actions for selected script text: save word, phrase, sentence, or add note. Keyboard
                shortcuts W, P, and S save word, phrase, and sentence respectively.
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {phraseHoverPreview && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.1 }}
              className="pointer-events-none fixed z-[80] max-w-64 -translate-x-1/2 -translate-y-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 text-xs shadow-lg backdrop-blur-xl"
              style={{ left: phraseHoverPreview.x, top: phraseHoverPreview.y - 8 }}
              role="tooltip"
            >
              <div className="font-semibold text-[var(--text)]">{phraseHoverPreview.text}</div>
              {phraseHoverPreview.loading ? (
                <div className="mt-1 h-3 w-24 animate-pulse rounded bg-white/10" />
              ) : phraseHoverPreview.data?.translation ? (
                <div className="mt-0.5 text-[var(--accent)]">
                  {phraseHoverPreview.data.translation.text}
                </div>
              ) : phraseHoverPreview.data ? (
                <div className="mt-0.5 text-[var(--text-faint)]">No translation found</div>
              ) : (
                <div className="mt-0.5 text-[var(--text-faint)]">Couldn&apos;t load translation</div>
              )}
              {!phraseHoverPreview.loading && phraseHoverPreview.data?.wordDetails?.definition && (
                <div className="mt-1 line-clamp-2 text-[var(--text-muted)]">
                  {phraseHoverPreview.data.wordDetails.definition}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {pendingDeleteItem && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
            role="status"
            className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-4 py-2 text-xs font-medium text-[var(--text)] shadow-xl backdrop-blur-xl"
          >
            <span className="max-w-[14rem] truncate">Removed &ldquo;{pendingDeleteItem.term}&rdquo;</span>
            <button
              type="button"
              onClick={undoDeleteLessonCapture}
              className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 font-semibold text-[var(--accent)] transition-colors hover:bg-white/20"
            >
              <Undo2 size={12} /> Undo
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
