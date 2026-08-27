"use client";

import { clsx } from "clsx";
import type { ReactNode, RefObject } from "react";
import { Check, Lightbulb } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import HintDisplay from "@/components/HintDisplay";
import ProgressBar from "@/components/ProgressBar";
import type { UXState, CheckAnswerResponse, HintLevel } from "@/lib/types";
import type { CompletedSentenceReview } from "../../types";
import { ControlBar } from "../ControlBar";
import { ReviewPreviousSentenceCard } from "../ReviewPreviousSentenceCard";
import { getWordShapeMask, overlayTypedOntoMask } from "@/lib/utils/segment";
import type { PracticeMode, SubtitleVisibility, SubtitleVisibilityState } from "../../types";

interface CurrentSegment {
  text: string;
}

export function DefaultLayout({
  videoId,
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
  maskOverlayRef,
  workspaceInputValue,
  onWorkspaceInputChange,
  onWorkspaceInputKeyDown,
  onWorkspaceCheck,
  practiceMode,
  workspaceStatus,
  isCheckingWorkspace,
  isLastResultClean,
  onDismissCheckResult,
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
}: {
  videoId: string;
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
  maskOverlayRef: RefObject<HTMLDivElement | null>;
  workspaceInputValue: string;
  onWorkspaceInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onWorkspaceInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onWorkspaceCheck: () => void;
  practiceMode: PracticeMode;
  workspaceStatus: "idle" | "success" | "error";
  isCheckingWorkspace: boolean;
  isLastResultClean: boolean;
  onDismissCheckResult: () => void;
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
}) {
  const isPracticing = uxState === "paused_waiting_input" || uxState === "playing" || uxState === "checking_answer";
  const showMask = practiceMode === "easy" && subtitleVisibility.original !== "hide" && !!currentSegment;
  const maskBlurred = subtitleVisibility.original === "blur";

  return (
    <>
      <div
        className={clsx(
          "relative w-full aspect-video rounded-3xl overflow-hidden shadow-xl border border-[var(--border-strong)] shrink-0 bg-black transition-all duration-300 ease-out",
          isZenMode ? "max-h-[50dvh] sm:max-h-[65vh]" : "max-h-[38dvh] sm:max-h-[320px]"
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

      {isPracticing && totalSegments > 0 && (
        <div className="mt-4">
          <ProgressBar currentIndex={currentSegIdx} totalSegments={totalSegments} accuracy={accuracy} tone="zen" />
        </div>
      )}

      {isPracticing && (
        <>
          <div className="flex items-stretch gap-2 mt-4">
            <div className="relative flex-1 min-w-0">
              <div
                onClick={() => workspaceInputRef.current?.focus()}
                className={`relative h-full rounded-2xl overflow-hidden border transition-all ${
                  workspaceStatus === "success"
                    ? "border-[var(--green)] bg-[var(--green)]/10"
                    : workspaceStatus === "error"
                    ? "border-[var(--red)] bg-[var(--red)]/10"
                    : `border-transparent bg-transparent focus-within:border-[var(--accent-border)] focus-within:bg-[var(--surface)] focus-within:ring-4 focus-within:ring-[var(--accent-soft)] ${isZenMode ? "focus-within:shadow-2xl" : ""}`
                }`}
              >
                {showMask && (
                  <div
                    ref={maskOverlayRef}
                    aria-hidden="true"
                    className={clsx(
                      "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre p-6 pr-32 sm:pr-28 text-xl font-mono tracking-wide text-[var(--text)]",
                      maskBlurred && "blur-sm"
                    )}
                  >
                    {overlayTypedOntoMask(getWordShapeMask(currentSegment?.text ?? ""), workspaceInputValue)}
                  </div>
                )}
                <input
                  ref={workspaceInputRef}
                  type="text"
                  value={workspaceInputValue}
                  onChange={onWorkspaceInputChange}
                  onKeyDown={onWorkspaceInputKeyDown}
                  enterKeyHint="done"
                  onScroll={(e) => {
                    if (maskOverlayRef.current) maskOverlayRef.current.scrollLeft = e.currentTarget.scrollLeft;
                  }}
                  onWheel={(e) => {
                    const el = e.currentTarget;
                    if (el.scrollWidth <= el.clientWidth) return;
                    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
                    if (delta === 0) return;
                    e.preventDefault();
                    el.scrollLeft += delta;
                  }}
                  placeholder="Type what you hear..."
                  className={clsx(
                    "w-full bg-transparent p-6 pr-32 sm:pr-28 text-xl outline-none",
                    showMask
                      ? "font-mono tracking-wide text-transparent caret-[var(--text)] placeholder:text-transparent"
                      : "font-medium text-[var(--text)] placeholder:text-[var(--text-faint)]"
                  )}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
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
                    ) : workspaceStatus === "error" ? (
                      <motion.button
                        key="error"
                        onClick={onDismissCheckResult}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="bg-[var(--red)] text-white px-4 py-2 rounded-xl font-bold text-sm shadow-lg active:scale-95 transition-all"
                      >
                        Try Again
                      </motion.button>
                    ) : (
                      <motion.button
                        key="idle"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        onClick={onWorkspaceCheck}
                        disabled={!workspaceInputValue.trim()}
                        className="bg-[var(--accent)] text-[#1a1206] px-6 py-2.5 rounded-xl font-bold text-sm hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg active:scale-95"
                      >
                        Check
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              <AnimatePresence>
                {workspaceStatus === "success" && isLastResultClean && (
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
            <button
              type="button"
              onClick={onToggleHintPanel}
              title={showHintPanel ? "Hide hint" : "Show hint"}
              aria-label={showHintPanel ? "Hide hint" : "Show hint"}
              aria-pressed={showHintPanel}
              className={clsx(
                "shrink-0 w-12 sm:w-14 flex items-center justify-center rounded-2xl border-2 transition-all active:scale-95",
                showHintPanel
                  ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--accent-border)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:bg-[var(--accent-soft)]"
              )}
            >
              <Lightbulb size={20} />
            </button>
          </div>

          {translationText && subtitleVisibility.translation !== "hide" && (
            <p
              className={clsx(
                "mt-2 text-center text-sm text-[var(--text-muted)]",
                subtitleVisibility.translation === "blur" && "blur-sm select-none"
              )}
            >
              {translationText}
            </p>
          )}

          {checkAnswerError && (
            <p role="alert" className="mt-2 flex items-center gap-2 text-xs text-[var(--red)]">
              {checkAnswerError}
              <button type="button" onClick={onWorkspaceCheck} className="font-semibold underline text-[var(--red)] hover:brightness-110">
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
                <div className="bg-[var(--red)]/10 border border-[var(--red)]/30 rounded-2xl p-5 mt-4">
                  <h4 className="text-[10px] font-black text-[var(--red)] uppercase tracking-[0.2em] mb-3">Correction Needed</h4>
                  <p className="font-mono text-sm leading-relaxed">
                    {checkResult.diff
                      .filter((t) => t.status !== "extra")
                      .map((t, i, arr) => (
                        <span key={i} className={clsx(t.status === "correct" ? "text-[var(--green)] font-medium" : "text-[var(--text-faint)]")}>
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
                      <span className="mt-2 inline-block rounded-full bg-[var(--purple)]/20 px-2 py-0.5 text-[11px] font-medium text-[var(--purple)]">
                        Extra: {extraCount}
                      </span>
                    ) : null;
                  })()}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showHintPanel && currentSegment && !checkResult?.isCorrect && (
              <motion.div
                key="hint-panel"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="overflow-hidden mt-4"
              >
                <HintDisplay text={currentSegment.text} level={hintLevel} onLevelChange={onHintLevelChange} />
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {shouldShowPreviousReview && previousReview && (
              <motion.div
                key="previous-review"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25, ease: "easeInOut" }}
                className="overflow-hidden mt-4"
              >
                <ReviewPreviousSentenceCard
                  previousReview={previousReview}
                  reviewTextContainerRef={reviewTextContainerRef}
                  handleReviewMouseUp={handleReviewMouseUp}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="mt-4">
            <ControlBar
              videoId={videoId}
              currentSegIdx={currentSegIdx}
              totalSegments={totalSegments}
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
            />
          </div>
        </>
      )}
    </>
  );
}
