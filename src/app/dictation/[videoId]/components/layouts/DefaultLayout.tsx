"use client";

import { clsx } from "clsx";
import type { ReactNode, RefObject } from "react";
import { Check } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import HintDisplay from "@/components/HintDisplay";
import type { UXState, CheckAnswerResponse, HintLevel } from "@/lib/types";
import type { CompletedSentenceReview } from "../../types";
import { ControlBar } from "../ControlBar";
import { ReviewPreviousSentenceCard } from "../ReviewPreviousSentenceCard";
import { SentenceWordInput } from "../SentenceWordInput";
import { ListeningTranscript } from "../ListeningTranscript";
import type { InputMode, PracticeMode, SubtitleVisibility, SubtitleVisibilityState } from "../../types";
import type { PersistedInputState } from "../../sessionPersistence";

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
  soundEnabled,
  onToggleSound,
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
  soundEnabled: boolean;
  onToggleSound: () => void;
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
}) {
  const isPracticing = uxState === "paused_waiting_input" || uxState === "playing" || uxState === "checking_answer";
  const isDictationMode = inputMode === "dictation";
  const hasWrongSubmission = workspaceStatus === "error" && !!checkResult;
  const showMask = practiceMode === "easy" && subtitleVisibility.original !== "hide" && !!currentSegment;
  const maskBlurred = subtitleVisibility.original === "blur";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={clsx(
          "relative w-full aspect-video rounded-3xl overflow-hidden shadow-xl border border-[var(--border-strong)] shrink-0 bg-black transition-all duration-300 ease-out",
          isZenMode ? "max-h-[50dvh] sm:max-h-[72vh]" : "max-h-[38dvh] sm:max-h-[52vh]"
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
          {/* Reserves a stable height for the sentence + translation area on
              mobile (below `lg`) so switching sentences never resizes this
              block and shifts the control bar below it — content is
              vertically centered within that reserved space instead. At
              `lg` and up, `contents` drops this wrapper out of the box model
              entirely, leaving the existing desktop layout untouched. */}
          <div className="mobile-transcript-area flex flex-col justify-center lg:contents">
          <div className="mt-3">
            <div className="relative min-w-0">
              <div
                hidden={!isDictationMode}
                onClick={() => workspaceInputRef.current?.focus()}
                className={`relative h-full rounded-2xl overflow-hidden border transition-all ${
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

              {!isDictationMode && (
                <div className="relative h-full rounded-2xl overflow-hidden border border-transparent">
                  <ListeningTranscript text={currentSegment?.text ?? ""} />
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

          {translationText && subtitleVisibility.translation !== "hide" && (
            <p
              className={clsx(
                "mt-2 text-center text-base text-[var(--text-muted)]",
                subtitleVisibility.translation === "blur" && "blur-sm select-none"
              )}
            >
              {translationText}
            </p>
          )}
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
              soundEnabled={soundEnabled}
              onToggleSound={onToggleSound}
              subtitleVisibility={subtitleVisibility}
              setOriginalVisibility={setOriginalVisibility}
              setTranslationVisibility={setTranslationVisibility}
              inputMode={inputMode}
              onSelectInputMode={onSelectInputMode}
              isVideoPlaying={isVideoPlaying}
              onTogglePlayback={onTogglePlayback}
              currentTimeSec={currentTimeSec}
              durationSec={durationSec}
            />
          </div>
        </>
      )}
    </div>
  );
}
