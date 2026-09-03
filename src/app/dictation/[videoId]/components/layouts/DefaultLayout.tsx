"use client";

import { clsx } from "clsx";
import type { ReactNode, RefObject } from "react";
import { Check } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import HintDisplay from "@/components/HintDisplay";
import type { AudioRecorderStatus, RecordedClip } from "@/hooks/useAudioRecorder";
import type { UXState, CheckAnswerResponse, HintLevel } from "@/lib/types";
import type { CompletedSentenceReview } from "../../types";
import { ControlBar } from "../ControlBar";
import { ReviewPreviousSentenceCard } from "../ReviewPreviousSentenceCard";
import { SentenceWordInput } from "../SentenceWordInput";
import { ListeningTranscript } from "../ListeningTranscript";
import { useTranscriptAutoFit } from "../../useTranscriptAutoFit";
import type { InputMode, PracticeMode, SubtitleVisibility, SubtitleVisibilityState } from "../../types";
import type { PersistedInputState } from "../../sessionPersistence";
import type { PLAYBACK_RATE_OPTIONS } from "../../constants";

interface CurrentSegment {
  text: string;
}

export function DefaultLayout({
  isZenMode,
  showVideo,
  videoBlock,
  uxState,
  currentSegIdx,
  totalSegments,
  onReset,
  onPrevious,
  onReplay,
  onNext,
  currentSegment,
  combo,
  subtitleVisibility,
  setOriginalVisibility,
  setTranslationVisibility,
  workspaceInputRef,
  resetSignal,
  onWorkspaceValueChange,
  onWorkspaceCheck,
  practiceMode,
  workspaceStatus,
  isCheckingWorkspace,
  isLastResultClean,
  checkAnswerError,
  checkResult,
  showHintPanel,
  onToggleHintPanel,
  hintLevel,
  onHintLevelChange,
  shouldShowPreviousReview,
  previousReview,
  reviewTextContainerRef,
  handleReviewMouseUp,
  accuracy,
  translationText,
  initialInputState,
  onRestoreConsumed,
  onInputStateChange,
  inputMode,
  onSelectInputMode,
  isVideoPlaying,
  onTogglePlayback,
  currentTimeSec,
  durationSec,
  playbackRate,
  setPlaybackRate,
  recorderStatus,
  onStartRecording,
  onStopRecording,
  recorderElapsedSec,
  recorderLevel,
  recordingClip,
}: {
  isZenMode: boolean;
  showVideo: boolean;
  videoBlock: ReactNode;
  uxState: UXState;
  currentSegIdx: number;
  totalSegments: number;
  onReset: () => void;
  onPrevious: () => void;
  onReplay: () => void;
  onNext: () => void;
  currentSegment: CurrentSegment | undefined;
  combo: number;
  subtitleVisibility: SubtitleVisibilityState;
  setOriginalVisibility: (value: SubtitleVisibility) => void;
  setTranslationVisibility: (value: SubtitleVisibility) => void;
  workspaceInputRef: RefObject<HTMLInputElement | null>;
  resetSignal: number;
  onWorkspaceValueChange: (value: string) => void;
  onWorkspaceCheck: () => void;
  practiceMode: PracticeMode;
  workspaceStatus: "idle" | "success" | "error";
  isCheckingWorkspace: boolean;
  isLastResultClean: boolean;
  checkAnswerError: string | null;
  checkResult: CheckAnswerResponse | null;
  showHintPanel: boolean;
  onToggleHintPanel: () => void;
  hintLevel: HintLevel;
  onHintLevelChange: (level: HintLevel) => void;
  shouldShowPreviousReview: boolean;
  previousReview: CompletedSentenceReview | null;
  reviewTextContainerRef: RefObject<HTMLDivElement | null>;
  handleReviewMouseUp: (event: React.MouseEvent<HTMLDivElement>) => void;
  accuracy: number;
  translationText: string | undefined;
  initialInputState?: PersistedInputState | null;
  onRestoreConsumed?: () => void;
  onInputStateChange?: (state: PersistedInputState) => void;
  inputMode: InputMode;
  onSelectInputMode: (mode: InputMode) => void;
  isVideoPlaying: boolean;
  onTogglePlayback: () => void;
  currentTimeSec: number;
  durationSec: number;
  playbackRate: (typeof PLAYBACK_RATE_OPTIONS)[number];
  setPlaybackRate: (rate: (typeof PLAYBACK_RATE_OPTIONS)[number]) => void;
  /** Owned by page.tsx (shared with a future Evaluation tab) — see
   *  "Shadowing and Pronunciation Practice Plan.md" §5.4/§7. Only meaningful
   *  in Shadowing; passed straight through to ControlBar. */
  recorderStatus: AudioRecorderStatus;
  onStartRecording: () => void;
  onStopRecording: () => void;
  recorderElapsedSec: number;
  recorderLevel: number;
  recordingClip: RecordedClip | null;
}) {
  const isPracticing = uxState === "paused_waiting_input" || uxState === "playing" || uxState === "checking_answer";
  const isDictationMode = inputMode === "dictation";
  const isSpeakingMode = inputMode === "shadowing";
  const hasWrongSubmission = workspaceStatus === "error" && !!checkResult;
  const showMask = practiceMode === "easy" && subtitleVisibility.original !== "hide" && !!currentSegment;
  const maskBlurred = subtitleVisibility.original === "blur";
  const showTranslation = !!translationText && subtitleVisibility.translation !== "hide";

  // Fits the English + Vietnamese pair inside the mobile transcript stage's
  // fixed height (shrinking font/gap, then falling back to internal scroll)
  // instead of letting the stage grow/shrink with each sentence — see
  // useTranscriptAutoFit for why that's what causes the page to jump.
  const { contentRef, measureRef, englishFontPx, gapPx, needsScroll } = useTranscriptAutoFit([
    currentSegIdx,
    currentSegment?.text,
    translationText,
    isDictationMode,
    showTranslation,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={clsx(
          "relative aspect-video shrink-0 overflow-hidden bg-black transition-all duration-300 ease-out",
          // Mobile: edge-to-edge, no card chrome — breaks out of `main`'s
          // px-4 so the video spans the full viewport width like a normal
          // mobile YouTube embed. Neutralized at `md` and up, where the
          // original bordered/rounded/shadowed card is restored unchanged.
          "-mx-4 w-[calc(100%+2rem)] rounded-none border-0 shadow-none",
          "md:mx-0 md:w-full md:rounded-3xl md:border md:border-[var(--border-strong)] md:shadow-xl",
          isZenMode ? "md:max-h-[72vh]" : "md:max-h-[52vh]"
        )}
      >
        <div
          className={clsx("absolute inset-0 transition-opacity duration-300 ease-out", !showVideo && "opacity-0 pointer-events-none")}
          aria-hidden={!showVideo}
        >
          {videoBlock}
        </div>
        <div
          className={clsx(
            "absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm transition-opacity duration-300 ease-out",
            showVideo ? "opacity-0 pointer-events-none" : "opacity-100"
          )}
          aria-hidden={showVideo}
        >
          <div className="rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-center text-xs text-white/85">
            Audio focus mode is enabled. Video is hidden.
          </div>
        </div>
      </div>

      {isPracticing && (
        <>
          {/* Fixed-height stage on mobile (below `md`) so switching sentences
              never resizes this block and shifts the control bar below it —
              useTranscriptAutoFit shrinks font/gap or scrolls internally
              instead of letting the box grow. `md:contents` (chained through
              every wrapper level here) drops the whole stage out of the box
              model at `md` and up, leaving the desktop layout untouched. */}
          <div className="mobile-transcript-stage md:contents">
          <div
            ref={contentRef}
            className="transcript-content h-full md:contents"
            style={{ overflowY: needsScroll ? "auto" : "hidden" }}
          >
          <div
            ref={measureRef}
            className="flex h-full flex-col justify-center md:contents"
            style={{ gap: `${gapPx}px` }}
          >
          {/* Not `md:contents` like its siblings above — it needs to keep
              contributing its own top margin (video-to-transcript spacing)
              at desktop too, which `display:contents` would otherwise strip. */}
          <div className="mt-3.5">
            <div className="relative min-w-0">
              <div
                hidden={!isDictationMode}
                onClick={() => workspaceInputRef.current?.focus()}
                className={`relative h-full rounded-2xl overflow-hidden border transition-colors ${
                  workspaceStatus === "success"
                    ? "border-[var(--green)] bg-[var(--green)]/10"
                    : workspaceStatus === "error"
                    ? "border-[var(--red)] bg-[var(--red)]/10"
                    : `border-transparent bg-transparent focus-within:border-[var(--accent-border)] focus-within:bg-[var(--surface)] focus-within:ring-4 focus-within:ring-[var(--accent-soft)] ${isZenMode ? "focus-within:shadow-2xl" : ""}`
                }`}
              >
                <SentenceWordInput
                  targetText={currentSegment?.text ?? ""}
                  resetToken={`${currentSegIdx}:${resetSignal}`}
                  inputRef={workspaceInputRef}
                  showMask={showMask}
                  maskBlurred={maskBlurred}
                  hasWrongSubmission={hasWrongSubmission}
                  onValueChange={onWorkspaceValueChange}
                  onSubmit={onWorkspaceCheck}
                  initialInputState={initialInputState}
                  onRestoreConsumed={onRestoreConsumed}
                  onInputStateChange={onInputStateChange}
                  fontSizePx={isDictationMode ? englishFontPx : undefined}
                />

                <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
                  <AnimatePresence mode="wait">
                    {isCheckingWorkspace ? (
                      <motion.div
                        key="loading"
                        role="status"
                        aria-live="polite"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        className="w-8 h-8 border-3 border-[var(--accent)] border-t-transparent rounded-full animate-spin"
                      >
                        <span className="sr-only">Checking…</span>
                      </motion.div>
                    ) : workspaceStatus === "success" ? (
                      <motion.div
                        key="success"
                        role="status"
                        aria-live="polite"
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ type: "spring", stiffness: 400, damping: 15 }}
                        className="relative bg-[var(--green)] text-[#06281c] p-2 rounded-xl flex items-center shadow-lg"
                      >
                        <Check size={20} strokeWidth={3} />
                        <span className="sr-only">Correct</span>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              </div>

              {(inputMode === "listening" || isSpeakingMode) && (
                <div className="relative h-full rounded-2xl overflow-hidden border border-transparent">
                  <ListeningTranscript text={currentSegment?.text ?? ""} fontSizePx={englishFontPx} />
                </div>
              )}

              <AnimatePresence>
                {isDictationMode && workspaceStatus === "success" && isLastResultClean && (
                  <motion.span
                    key="first-try-badge"
                    initial={{ opacity: 0, y: 4, scale: 0.8 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute -top-3 right-4 z-20 whitespace-nowrap rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] font-bold text-[#1a1206] shadow"
                  >
                    ⚡ First try
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </div>

          {showTranslation && (
            <p
              className={clsx(
                "mt-0 text-center text-base text-[var(--text-muted)] md:mt-1",
                subtitleVisibility.translation === "blur" && "blur-sm select-none"
              )}
            >
              {translationText}
            </p>
          )}
          </div>
          </div>
          </div>

          {checkAnswerError && (
            <p role="alert" className="mt-2 flex items-center gap-2 text-xs text-[var(--red)]">
              {checkAnswerError}
              <button type="button" onClick={onWorkspaceCheck} className="font-semibold underline text-[var(--red)] hover:brightness-110">
                Retry
              </button>
            </p>
          )}

          <AnimatePresence>
            {showHintPanel && currentSegment && !checkResult?.isCorrect && (
              <motion.div
                key="hint-panel"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="overflow-hidden mt-3"
              >
                <HintDisplay text={currentSegment.text} level={hintLevel} onLevelChange={onHintLevelChange} />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="mt-auto flex flex-col gap-2.5 pt-3">
            <AnimatePresence>
              {shouldShowPreviousReview && previousReview && (
                <motion.div
                  key="previous-review"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                  className="overflow-hidden"
                >
                  <ReviewPreviousSentenceCard
                    previousReview={previousReview}
                    reviewTextContainerRef={reviewTextContainerRef}
                    handleReviewMouseUp={handleReviewMouseUp}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            <ControlBar
              currentSegIdx={currentSegIdx}
              totalSegments={totalSegments}
              accuracy={accuracy}
              onReset={onReset}
              onPrevious={onPrevious}
              onReplay={onReplay}
              onNext={onNext}
              prevDisabled={currentSegIdx === 0}
              nextDisabled={currentSegIdx >= totalSegments - 1}
              showHintPanel={showHintPanel}
              onToggleHint={onToggleHintPanel}
              combo={combo}
              subtitleVisibility={subtitleVisibility}
              setOriginalVisibility={setOriginalVisibility}
              setTranslationVisibility={setTranslationVisibility}
              inputMode={inputMode}
              onSelectInputMode={onSelectInputMode}
              isVideoPlaying={isVideoPlaying}
              onTogglePlayback={onTogglePlayback}
              currentTimeSec={currentTimeSec}
              durationSec={durationSec}
              playbackRate={playbackRate}
              setPlaybackRate={setPlaybackRate}
              recorderStatus={recorderStatus}
              onStartRecording={onStartRecording}
              onStopRecording={onStopRecording}
              recorderElapsedSec={recorderElapsedSec}
              recorderLevel={recorderLevel}
              recordingClip={recordingClip}
            />
          </div>
        </>
      )}
    </div>
  );
}
