"use client";

import { use, useState, useCallback, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import {
  ArrowLeft,
  PanelRightClose,
  PanelRightOpen,
  SkipBack,
  SkipForward,
  Repeat,
  Lightbulb,
  Check,
  X,
  FileText,
  Bookmark,
  Sparkles,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

import YouTubePlayer from "@/components/YouTubePlayer";
import HintDisplay from "@/components/HintDisplay";
import AIExplainer from "@/components/AIExplainer";
import ProgressBar from "@/components/ProgressBar";
import UserButton from "@/components/UserButton";
import VocabularySaveButton from "@/components/VocabularySaveButton";
import { StatusCard } from "@/components/StatusCard";

import { usePlayerStore } from "@/store/playerStore";
import { useSessionStore, selectAccuracy } from "@/store/sessionStore";
import { useAuth, useRequireAuth } from "@/context/auth";
import { useManualTranscriptPaste } from "./useManualTranscriptPaste";
import { useVideoSizeMode } from "./useVideoSizeMode";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useLessonCapture } from "./useLessonCapture";
import { useDictationSession } from "./useDictationSession";

import { ControlButton } from "./components/ControlButton";
import { LessonSavedItemsList } from "./components/LessonSavedItemsList";
import { ComparedSentenceText } from "./components/ComparedSentenceText";
import { SCRIPT_POPOVER_MAX_WIDTH_PX, SCRIPT_CONTEXT_NEXT_COUNT, SCRIPT_CONTEXT_PREVIOUS_COUNT, VIDEO_SIZE_MODE_CLASS } from "./constants";
import { getSavedFilterLabel, buildComparedTokens } from "./helpers";
import type { SavedFilter, RightPanelTab } from "./types";

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
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("saved");
  const [showPreviousScriptContext, setShowPreviousScriptContext] = useState(false);
  const [showScriptContext, setShowScriptContext] = useState(true);
  const [showVideo, setShowVideo] = useState(true);
  const [workspaceInputValue, setWorkspaceInputValue] = useState("");
  const [isZenMode, setIsZenMode] = useState(false);
  const [showHintPanel, setShowHintPanel] = useState(false);

  const { videoSizeMode, setVideoSizeMode } = useVideoSizeMode();

  const workspaceInputRef = useRef<HTMLInputElement>(null);
  const previousShowVideoRef = useRef(showVideo);

  const {
    currentSegIdx,
    uxState,
    checkResult,
    setCheckResult,
    hintLevel,
    setHintLevel,
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
  } = useDictationSession({ videoId, user });

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
  const videoBlock = shouldRenderVideoPlayer && (
    <div className={clsx("mx-auto flex h-full w-full transition-all duration-200", VIDEO_SIZE_MODE_CLASS[videoSizeMode])}>
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
    savedFilter,
    setSavedFilter,
    filteredSavedItems,
    scriptPopover,
    scriptShowAI,
    scriptAiReady,
    setScriptAiReady,
    scriptPopoverNoteMode,
    setScriptPopoverNoteMode,
    scriptAiPayload,
    scriptPopoverNoteInputRef,
    scriptTextContainerRef,
    reviewTextContainerRef,
    scriptPopoverRef,
    handleLearningNoteChange,
    deleteLessonCapture,
    updateLessonCapture,
    handleScriptMouseUp,
    handleReviewMouseUp,
    handleScriptPopoverAction,
  } = useLessonCapture({
    videoId,
    user,
    requireAuth,
    segments,
    currentSegIdx,
    currentSegmentText: currentSegment?.text,
    showScriptContext,
    onAfterSave: () => setShowLearningPanel(true),
  });

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
    if (!showLearningPanel || rightPanelTab !== "script") return;
    const container = scriptTextContainerRef.current;
    if (!container) return;
    const currentCard = container.querySelector<HTMLElement>(
      `[data-script-segment-index="${currentSegIdx}"]`
    );
    currentCard?.scrollIntoView({ block: "nearest" });
  }, [currentSegIdx, rightPanelTab, showLearningPanel, scriptTextContainerRef]);

  const workspaceTitle = transcriptTitle ?? `Video ${videoId}`;
  const sentenceProgressLabel =
    segments.length > 0
      ? `Sentence ${Math.min(currentSegIdx + 1, segments.length)} of ${segments.length}`
      : "Preparing transcript…";

  const isCheckingWorkspace = uxState === "checking_answer" && checkResult === null;
  const workspaceStatus: "idle" | "success" | "error" = checkResult
    ? checkResult.isCorrect
      ? "success"
      : "error"
    : "idle";

  // ---- Render ----
  return (
    <div className="relative h-screen overflow-hidden flex flex-col w-full bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />
      <AnimatePresence>
        {isZenMode && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-slate-950/90 backdrop-blur-2xl z-0 transition-all pointer-events-none"
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!isZenMode && (
          <motion.header
            initial={{ y: -64, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -64, opacity: 0 }}
            className="sticky top-0 z-10 w-full border-b border-white/40 bg-white/30 px-4 py-1 backdrop-blur-md"
          >
            <div className="mx-auto flex w-full max-w-none items-center justify-between">
              <div className="flex min-w-0 items-center gap-4">
                <Link href="/" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100" aria-label="Back to dashboard">
                  <ArrowLeft size={18} />
                </Link>
                <div className="min-w-0">
                  <h1 className="truncate text-sm font-semibold leading-tight text-slate-900">{workspaceTitle}</h1>
                  <span className="text-xs text-slate-500">{sentenceProgressLabel}</span>
                </div>
              </div>
              <UserButton />
            </div>
          </motion.header>
        )}
      </AnimatePresence>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col overflow-y-auto px-4 gap-4 lg:flex-row lg:overflow-hidden">
        <motion.div
          layout
          transition={{ type: "tween", ease: "linear", duration: 0.25 }}
          className={clsx(
            "flex flex-col min-h-0 lg:flex-1 lg:overflow-hidden",
            isZenMode && "z-50"
          )}
        >
          <div className="flex-shrink-0 space-y-2 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowVideo((v) => !v)}
              className="text-xs font-bold px-3 py-1.5 rounded-lg border border-white/60 bg-white/40 text-slate-600 hover:bg-white/80 transition-colors flex items-center gap-2"
            >
              <Sparkles size={14} className="text-indigo-500" />
              {showVideo ? "Audio Mode" : "Exit Audio Mode"}
            </button>
            <button
              onClick={() => setIsZenMode(true)}
              className="text-xs font-bold px-3 py-1.5 rounded-lg border border-white/60 bg-white/40 text-slate-600 hover:bg-white/80 transition-colors flex items-center gap-2"
            >
              <Sparkles size={14} className="text-indigo-500" />
              Zen Mode
            </button>

            <div className="flex items-center rounded-full border border-white/70 bg-white/60 p-1 shadow-sm backdrop-blur-md">
              <button
                onClick={() => setVideoSizeMode("standard")}
                className={clsx(
                  "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                  videoSizeMode === "standard"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-600 hover:bg-white/80"
                )}
              >
                Standard
              </button>
              <button
                onClick={() => setVideoSizeMode("large")}
                className={clsx(
                  "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                  videoSizeMode === "large"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-600 hover:bg-white/80"
                )}
              >
                Large
              </button>
            </div>

          </div>

          <div className={clsx("relative w-full aspect-video max-h-[320px] rounded-3xl overflow-hidden shadow-xl border border-white/20 shrink-0 transition-transform bg-black", isZenMode && "scale-105")}>
            <div className={clsx("absolute inset-0", !showVideo && "opacity-0 pointer-events-none")} aria-hidden={!showVideo}>
              {videoBlock}
            </div>
            {!showVideo && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
                <div className="rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-center text-xs text-white/85">
                  Audio focus mode is enabled. Video is hidden.
                </div>
              </div>
            )}
          </div>

          {(uxState === "paused_waiting_input" || uxState === "playing" || uxState === "checking_answer") && (
            <div className="relative z-10 flex items-center gap-7 px-4 pt-4 h-16 rounded-3xl border border-white/60 bg-white/40 backdrop-blur-md shadow-md mt-4">
              <div className="flex items-center gap-2 shrink-0">
                <ControlButton icon={<SkipBack size={18} />} shortcut="Shift + <-" label="Prev" onClick={handlePrevious} disabled={currentSegIdx === 0} />
                <ControlButton icon={<Repeat size={18} />} shortcut="Shift + Space" label="Replay" primary onClick={handleReplay} />
                <ControlButton icon={<SkipForward size={18} />} shortcut="Shift + ->" label="Next" onClick={handleSkip} disabled={currentSegIdx >= segments.length - 1} />
              </div>
              {segments.length > 0 && (
                <div className="flex-1 min-w-0">
                  <ProgressBar currentIndex={currentSegIdx} totalSegments={segments.length} accuracy={accuracy} />
                </div>
              )}
            </div>
          )}
          </div>

          <div className="py-3 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
          <div className={`bg-white/40 dark:bg-slate-800/40 backdrop-blur-xl border border-white/60 dark:border-white/10 rounded-3xl p-4 flex flex-col gap-3 shadow-xl transition-all ${isZenMode ? "bg-slate-900/40 border-white/5" : ""}`}>

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
              <div role="alert" className="rounded-xl border border-red-300/60 bg-red-50/50 backdrop-blur-md p-5 flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <p className="text-2xl" aria-hidden="true">❌</p>
                  <p className="font-semibold text-slate-800">Transcript failed</p>
                  <p className="text-sm text-slate-500">
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
                  className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
                {manualPasteError && (
                  <p className="text-sm text-red-600">{manualPasteError}</p>
                )}
                <div>
                  <button
                    onClick={handleManualTranscriptSubmit}
                    disabled={manualPasteSubmitting || manualPasteText.trim().length === 0}
                    className="px-5 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {manualPasteSubmitting ? "Saving..." : "Use this transcript"}
                  </button>
                </div>
              </div>
            )}

            {uxState === "transcript_ready" && segments.length > 0 && (
              <div className="rounded-xl border border-emerald-300/60 bg-emerald-50/50 backdrop-blur-md p-4 flex flex-col gap-3 mb-4">
                <p className="text-emerald-700 font-semibold">Transcript ready - {segments.length} sentences</p>
                <p className="text-sm text-slate-600">Press the button below to start. The video will play each sentence one at a time and pause so you can type what you heard.</p>
                <div className="flex items-center gap-3 mt-1">
                  {resumeState ? (
                    <>
                      <button onClick={handleResume} className="px-6 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700 transition-colors">
                        Resume at sentence {resumeState.currentSegmentIndex + 1}
                      </button>
                      <button onClick={handleRestart} className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 font-semibold text-sm hover:bg-slate-50 transition-colors">
                        Restart
                      </button>
                    </>
                  ) : (
                    <button onClick={handleStart} className="px-6 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700 transition-colors">
                      Start Dictation
                    </button>
                  )}
                </div>
                {resumeLoading && <p className="text-xs text-slate-500">Checking for saved progress...</p>}
              </div>
            )}

            {(uxState === "paused_waiting_input" || uxState === "playing" || uxState === "checking_answer") && (
              <>
                <div className="relative">
                  <div className={`relative rounded-2xl overflow-hidden border-2 transition-all ${
                    workspaceStatus === "success"
                      ? "border-emerald-500 bg-emerald-50/30"
                      : workspaceStatus === "error"
                      ? "border-red-500 bg-red-50/30"
                      : `border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900 focus-within:border-indigo-500 focus-within:ring-4 focus-within:ring-indigo-500/10 ${isZenMode ? "shadow-2xl" : ""}`
                  }`}>
                    <input
                      ref={workspaceInputRef}
                      type="text"
                      value={workspaceInputValue}
                      onChange={(e) => {
                        setWorkspaceInputValue(e.target.value);
                        setCheckResult(null);
                      }}
                      onKeyDown={handleWorkspaceInputKeyDown}
                      placeholder="Type what you hear..."
                      className="w-full bg-transparent p-6 pr-39 text-xl font-medium text-slate-900 dark:text-white placeholder:text-slate-400 outline-none"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />

                    <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowHintPanel((prev) => !prev)}
                        title={showHintPanel ? "Hide hint" : "Show hint"}
                        aria-label={showHintPanel ? "Hide hint" : "Show hint"}
                        aria-pressed={showHintPanel}
                        className={clsx(
                          "h-9 w-9 flex items-center justify-center rounded-xl border-yellow-500 bg-yellow-100 transition-all active:scale-95" + " hover:bg-yellow-300 hover:border-yellow-300",
                          showHintPanel
                            ? "bg-indigo-100 border-indigo-300 text-indigo-600"
                            : "bg-white/70 border-white/80 text-slate-500 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600"
                        )}
                      >
                        <Lightbulb size={17} />
                      </button>
                      <AnimatePresence mode="wait">
                        {isCheckingWorkspace ? (
                          <motion.div
                            key="loading"
                            role="status"
                            aria-live="polite"
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.8 }}
                            className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin"
                          >
                            <span className="sr-only">Checking…</span>
                          </motion.div>
                        ) : workspaceStatus === "success" ? (
                          <motion.div
                            key="success"
                            role="status"
                            aria-live="polite"
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="bg-emerald-500 text-white p-2 rounded-xl flex items-center shadow-lg"
                          >
                            <Check size={20} strokeWidth={3} />
                            <span className="sr-only">Correct</span>
                          </motion.div>
                        ) : workspaceStatus === "error" ? (
                          <motion.button
                            key="error"
                            onClick={() => setCheckResult(null)}
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="bg-red-500 text-white px-4 py-2 rounded-xl font-bold text-sm shadow-lg active:scale-95 transition-all"
                          >
                            Try Again
                          </motion.button>
                        ) : (
                          <motion.button
                            key="idle"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            onClick={handleWorkspaceCheck}
                            disabled={!workspaceInputValue.trim()}
                            className="bg-indigo-600 text-white px-6 py-2.5 rounded-xl font-bold text-sm hover:bg-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/20 active:scale-95"
                          >
                            Check
                          </motion.button>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>

                {checkAnswerError && (
                  <p role="alert" className="mt-2 flex items-center gap-2 text-xs text-red-600">
                    {checkAnswerError}
                    <button
                      type="button"
                      onClick={handleWorkspaceCheck}
                      className="font-semibold underline text-red-700 hover:text-red-900"
                    >
                      Retry
                    </button>
                  </p>
                )}

                <AnimatePresence>
                  {workspaceStatus === "error" && checkResult && (
                    <motion.div
                      initial={{ height: 0, opacity: 0, scale: 0.95 }}
                      animate={{ height: "auto", opacity: 1, scale: 1 }}
                      exit={{ height: 0, opacity: 0, scale: 0.95 }}
                      className="overflow-hidden"
                    >
                      <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-5 mt-4">
                        <h4 className="text-[10px] font-black text-red-500 uppercase tracking-[0.2em] mb-3">Correction Needed</h4>
                        <p className="font-mono text-sm leading-relaxed">
                          {checkResult.diff
                            .filter((t) => t.status !== "extra")
                            .map((t, i, arr) => (
                              <span
                                key={i}
                                className={clsx(t.status === "correct" ? "text-emerald-700 font-medium" : "text-slate-400")}
                              >
                                {t.status === "correct" ? t.word : "***"}
                                {i < arr.length - 1 ? " " : ""}
                              </span>
                            ))}
                        </p>
                        {(() => {
                          const userWordCount = checkResult.normalizedUser.split(" ").filter(Boolean).length;
                          const expectedWordCount = checkResult.normalizedExpected.split(" ").filter(Boolean).length;
                          const extraCount = userWordCount > expectedWordCount ? userWordCount - expectedWordCount : 0;
                          return extraCount > 0 ? (
                            <span className="mt-2 inline-block rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                              Extra: {extraCount}
                            </span>
                          ) : null;
                        })()}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {showHintPanel && currentSegment && !checkResult?.isCorrect && (
                  <div>
                    <HintDisplay text={currentSegment.text} level={hintLevel} onLevelChange={(l) => setHintLevel(l)} />
                  </div>
                )}

                {shouldShowPreviousReview && previousReview && (
                  <div ref={reviewTextContainerRef} onMouseUp={handleReviewMouseUp} className="rounded-xl border border-white/60 bg-white/50 backdrop-blur-md p-3 flex flex-col gap-2 mt-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Review previous sentence</p>
                      <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">#{previousReview.segmentIndex + 1}</span>
                    </div>
                    <div data-script-segment-index={previousReview.segmentIndex} data-selection-sentence-text={previousReview.expectedText} className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-2 text-xs text-slate-700">
                      <p className="text-[11px] font-semibold text-slate-500">Correct sentence</p>
                      <ComparedSentenceText
                        tokens={buildComparedTokens({ diff: previousReview.diff, expectedText: previousReview.expectedText, userText: previousReview.firstUserText }).expectedTokens}
                        tone="expected"
                      />
                    </div>
                    <div data-script-segment-index={previousReview.segmentIndex} data-selection-sentence-text={previousReview.expectedText} className="rounded-lg border border-slate-200 bg-slate-100 p-2 text-xs text-slate-700">
                      <p className="text-[11px] font-semibold text-slate-500">Your answer</p>
                      <ComparedSentenceText
                        tokens={buildComparedTokens({ diff: previousReview.diff, expectedText: previousReview.expectedText, userText: previousReview.firstUserText }).userTokens}
                        tone="user"
                        emptyFallback="(No answer provided)"
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            <AnimatePresence>
              {isZenMode && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 20 }}
                  className="mt-8 flex justify-center"
                >
                  <button onClick={() => setIsZenMode(false)} className="group flex flex-col items-center gap-2">
                    <div className="w-12 h-12 rounded-full bg-white/10 border border-white/20 backdrop-blur-md flex items-center justify-center text-white/50 group-hover:text-white group-hover:bg-white/20 transition-all group-hover:scale-110">
                      <X size={24} />
                    </div>
                    <span className="text-[10px] uppercase font-black tracking-widest text-white/30 group-hover:text-white/60 transition-colors">Exit Zen Mode</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {uxState === "session_completed" && (
              <div className="rounded-xl border border-indigo-300/60 bg-indigo-50/50 backdrop-blur-md p-6 flex flex-col gap-4 mt-6">
                <div className="text-center">
                  <p className="text-3xl">🎉</p>
                  <p className="text-indigo-700 font-bold text-xl">Session Complete!</p>
                  <p className="text-slate-600 text-sm mt-1">Final accuracy: <span className="font-bold">{accuracy}%</span> over {sessionStore.totalAttempts} attempts.</p>
                </div>
                {mistakes.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-slate-700 font-semibold text-sm">Mistakes ({mistakes.length} sentence{mistakes.length !== 1 ? "s" : ""}):</p>
                    <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                      {mistakes.map((m) => (
                        <div key={m.segIdx} className="bg-white/50 backdrop-blur-md rounded-lg border border-white/60 p-3 flex flex-col gap-1">
                          <span className="text-xs text-slate-400 font-medium">Sentence {m.segIdx + 1}</span>
                          <span className="text-sm text-slate-800">{m.expectedText}</span>
                          <span className="text-xs text-red-500">You typed: {m.userText || <span className="italic text-slate-400">nothing</span>}</span>
                          <VocabularySaveButton videoId={videoId} segmentIndex={m.segIdx} sentenceContext={m.expectedText} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-emerald-600 text-sm font-medium text-center">Perfect session - no mistakes!</p>
                )}
                <Link href="/" className="mt-2 inline-block rounded-xl bg-indigo-600 text-white px-6 py-2 font-semibold hover:bg-indigo-700 transition-colors text-center">
                  Try another video
                </Link>
              </div>
            )}
          </div>
          </div>
        </motion.div>

        {!isZenMode && (
          <AnimatePresence initial={false}>
            {showLearningPanel && (
              <motion.div
                key="learning-panel"
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 16 }}
                transition={{ duration: 0.2 }}
                className="w-full shrink-0 overflow-hidden lg:h-full lg:w-[360px]"
              >
                <div className="w-full h-full flex flex-col bg-white/60 dark:bg-slate-800/60 backdrop-blur-xl border border-white/80 dark:border-white/10 rounded-3xl shadow-lg overflow-hidden">
              <div className="p-4 border-b border-white/40 dark:border-white/10 bg-white/30 dark:bg-slate-900/40 backdrop-blur-md">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <h2 className="font-semibold text-slate-900 dark:text-white">Lesson panel</h2>
                  <button
                    onClick={() => setShowLearningPanel(false)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/70 bg-white/60 text-slate-700 shadow-sm backdrop-blur-md transition-all hover:bg-white"
                    aria-label="Hide lesson panel"
                  >
                    <PanelRightClose size={16} />
                  </button>
                </div>
                <div className="flex bg-white/40 dark:bg-slate-900/40 border border-white/60 dark:border-white/10 p-1 rounded-xl shadow-inner text-slate-900 dark:text-white">
                <button
                  onClick={() => setRightPanelTab("script")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-bold rounded-lg transition-all ${rightPanelTab === "script" ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm border border-white/60 dark:border-white/10" : "text-slate-500 dark:text-slate-400 hover:text-indigo-600"}`}
                >
                  <FileText size={16} /> Script
                </button>
                <button
                  onClick={() => setRightPanelTab("saved")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-bold rounded-lg transition-all ${rightPanelTab === "saved" ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm border border-white/60 dark:border-white/10" : "text-slate-500 dark:text-slate-400 hover:text-indigo-600"}`}
                >
                  <Bookmark size={16} /> Saved
                </button>
              </div>
                </div>

              <div className="flex flex-col gap-4 p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {rightPanelTab === "saved" ? (
                <>
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
                    <div className="flex flex-col items-center justify-center h-full text-center px-4">
                      <Bookmark size={32} className="text-slate-300 dark:text-slate-600 mb-3" />
                      <p className="text-slate-500 dark:text-slate-400 text-xs font-medium">
                        {savedFilter === "all"
                          ? "No saved vocabulary yet."
                          : `No ${getSavedFilterLabel(savedFilter).toLowerCase()} saved yet.`}
                      </p>
                    </div>
                  ) : (
                    <LessonSavedItemsList
                      items={filteredSavedItems}
                      compact
                      scrollClassName="h-full"
                      deletingId={learningDeletingId}
                      updatingId={learningUpdatingId}
                      onDelete={deleteLessonCapture}
                      onUpdate={updateLessonCapture}
                    />
                  )}
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => setShowScriptContext((prev) => !prev)} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50">
                      {showScriptContext ? "Hide script" : "Show script"}
                    </button>
                    {currentSegIdx > 0 && (
                      <button onClick={() => setShowPreviousScriptContext((prev) => !prev)} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50">
                        {showPreviousScriptContext ? "Hide previous" : "Show previous"}
                      </button>
                    )}
                    <button
                      onClick={handleRegenerateClick}
                      disabled={regenerating}
                      title="Re-fetch this video's script from YouTube's captions if it doesn't match the audio"
                      className="rounded-md border border-indigo-300 bg-indigo-50 px-2.5 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {regenerating ? "Regenerating…" : "Regenerate script"}
                    </button>
                  </div>
                  {regenerateError && <p className="text-xs text-red-600">{regenerateError}</p>}
                  {scriptContextSegments.length === 0 ? (
                    <p className="text-xs text-slate-500">Script is not available yet.</p>
                  ) : !showScriptContext ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">Script context is hidden. Use Show script when you want to reveal it.</div>
                  ) : (
                    <div ref={scriptTextContainerRef} onMouseUp={handleScriptMouseUp} className="relative flex flex-col gap-3 pr-1 text-sm lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                      {scriptContextSegments.map((segment) => {
                        const isCurrentScriptSentence = segment.segmentIndex === currentSegIdx;
                        const isPreviousScriptSentence = segment.segmentIndex < currentSegIdx;
                        return (
                          <div
                            key={segment.segmentIndex}
                            data-script-segment-index={segment.segmentIndex}
                            data-selection-sentence-text={segment.text}
                            className={`p-4 rounded-xl border transition-colors shadow-sm ${
                              isCurrentScriptSentence
                                ? "bg-white/80 dark:bg-slate-700/60 border-indigo-200 dark:border-indigo-500/40 ring-2 ring-indigo-500/20"
                                : isPreviousScriptSentence
                                ? "bg-white/40 dark:bg-white/5 border-white/60 dark:border-white/10 opacity-80 hover:opacity-100"
                                : "bg-white/40 dark:bg-white/5 border-white/60 dark:border-white/10 opacity-80 hover:opacity-100"
                            }`}
                          >
                            <div className={`text-xs font-bold mb-1 flex items-center justify-between ${isCurrentScriptSentence ? "text-indigo-600 dark:text-indigo-400" : isPreviousScriptSentence ? "text-emerald-600" : "text-slate-500"}`}>
                              <span className="uppercase tracking-widest text-[9px]">Sentence #{segment.segmentIndex + 1}</span>
                              {isCurrentScriptSentence && <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />}
                            </div>
                            <p className={`text-sm leading-relaxed select-text ${isCurrentScriptSentence ? "text-slate-900 dark:text-white font-medium" : "text-slate-600 dark:text-slate-400"}`}>{segment.text}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {learningError && (
                    <p role="alert" className="flex items-center gap-2 text-xs text-red-600">
                      {learningError}
                      {learningErrorRetry && (
                        <button
                          type="button"
                          onClick={() => learningErrorRetry()}
                          className="font-semibold underline text-red-700 hover:text-red-900"
                        >
                          Retry
                        </button>
                      )}
                    </p>
                  )}
                </>
              )}
                </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        )}

        {!isZenMode && !showLearningPanel && (
          <div className="flex w-full justify-end lg:w-auto lg:justify-start lg:self-start lg:pt-3">
            <button
              onClick={() => setShowLearningPanel(true)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/80 bg-white/60 text-slate-700 shadow-sm backdrop-blur-md transition-colors hover:bg-white"
              aria-label="Show lesson panel"
            >
              <PanelRightOpen size={16} />
            </button>
          </div>
        )}

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
      </main>

      {scriptShowAI && scriptPopover && (
        <div className="mx-auto w-full max-w-7xl px-4 lg:px-6 pb-4">
          <AIExplainer
            expectedText={scriptAiPayload.expectedText}
            userText={scriptAiPayload.userText}
            buttonLabel={scriptAiPayload.buttonLabel}
            onExplanationReady={setScriptAiReady}
          />
          {scriptAiReady && (
            <p className="mt-2 text-xs text-slate-500">
              Selection: <span className="font-medium text-slate-700">{scriptPopover.selectedText}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
