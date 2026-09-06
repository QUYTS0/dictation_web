"use client";

import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import {
  Eye,
  Gauge,
  Lightbulb,
  Loader2,
  Mic,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Repeat,
} from "lucide-react";
import { ControlButton } from "./ControlButton";
import { ComboStreak } from "./ComboStreak";
import { SubtitleVisibilityPopup } from "./SubtitleVisibilityPopup";
import { ModeSwitcher } from "./ModeSwitcher";
import { MobileBottomSheet } from "./MobileBottomSheet";
import { formatClockTime } from "../helpers";
import { INPUT_MODE_LABELS, MODE_ICONS, PLAYBACK_RATE_OPTIONS } from "../constants";
import type { EvaluationUiState } from "../evaluationFeedback";
import type { InputMode, SubtitleVisibility, SubtitleVisibilityState } from "../types";
import type { AudioRecorderStatus, RecordedClip } from "@/hooks/useAudioRecorder";

// Tiny in-button level meter — shown in place of the mic icon while
// recording (see "Shadowing and Pronunciation Practice Plan.md" §5.1). Three
// bars with slightly different sensitivity so they don't move in perfect
// lockstep; uses `currentColor` so it inherits the button's red "recording"
// text color automatically.
function MiniLevelMeter({ level }: { level: number }) {
  const clamped = Math.min(1, Math.max(0, level));
  const heights = [0.5, 1, 0.7].map((mult) => 3 + clamped * mult * 11);
  return (
    <div className="flex h-[18px] items-end gap-[2px]" aria-hidden="true">
      {heights.map((h, i) => (
        <span key={i} className="w-[3px] rounded-full bg-current transition-[height] duration-75" style={{ height: `${h}px` }} />
      ))}
    </div>
  );
}

export function ControlBar({
  currentSegIdx,
  totalSegments,
  accuracy,
  onReset,
  onPrevious,
  onReplay,
  onNext,
  prevDisabled,
  nextDisabled,
  showHintPanel,
  onToggleHint,
  combo,
  subtitleVisibility,
  setOriginalVisibility,
  setTranslationVisibility,
  inputMode,
  onSelectInputMode,
  isVideoPlaying,
  onTogglePlayback,
  currentTimeSec,
  durationSec,
  playbackRate,
  setPlaybackRate,
  recorderStatus = "idle",
  onStartRecording = () => {},
  onStopRecording = () => {},
  recorderElapsedSec = 0,
  recorderLevel = 0,
  recordingClip = null,
  isPlayingMyRecording = false,
  onToggleMyRecordingPlayback = () => {},
  evaluationEngineConfigured = false,
  evaluationLimitReached = false,
  evaluationUiState = "no-recording",
  latestScore = null,
  onTriggerEvaluation = () => {},
  onOpenEvaluationDetails = () => {},
}: {
  currentSegIdx: number;
  totalSegments: number;
  accuracy: number;
  onReset: () => void;
  onPrevious: () => void;
  onReplay: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
  showHintPanel: boolean;
  onToggleHint: () => void;
  combo: number;
  subtitleVisibility: SubtitleVisibilityState;
  setOriginalVisibility: (value: SubtitleVisibility) => void;
  setTranslationVisibility: (value: SubtitleVisibility) => void;
  inputMode: InputMode;
  onSelectInputMode: (mode: InputMode) => void;
  isVideoPlaying: boolean;
  onTogglePlayback: () => void;
  currentTimeSec: number;
  durationSec: number;
  playbackRate: (typeof PLAYBACK_RATE_OPTIONS)[number];
  setPlaybackRate: (rate: (typeof PLAYBACK_RATE_OPTIONS)[number]) => void;
  /** Only meaningful in Shadowing — drives the center button's Record/Stop
   *  state in place of Hint/Play-Pause. Optional (with safe no-op defaults)
   *  so the Dictation/Listening call site, which never uses them, doesn't
   *  need to pass anything. */
  recorderStatus?: AudioRecorderStatus;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  /** Live seconds elapsed — shown in the Record/Stop button's hover label
   *  and title, the same way every other button surfaces extra detail. */
  recorderElapsedSec?: number;
  /** 0..1 live mic level — drives the in-button mini level meter. */
  recorderLevel?: number;
  /** The current take, if any — drives the adjacent Play/Pause My Recording
   *  button (disabled until a clip exists). */
  recordingClip?: RecordedClip | null;
  /** Headless playback state/toggle for "Play/Pause My Recording" — lifted
   *  up to page.tsx (rather than called here) so the same toggle function
   *  can also be bound to a keyboard shortcut. No seek bar, time, or volume
   *  control, since this button has no dedicated surface to show them in. */
  isPlayingMyRecording?: boolean;
  onToggleMyRecordingPlayback?: () => void;
  /** Whether Azure Pronunciation Assessment is configured server-side — the
   *  third Shadowing center button only renders when this is true, mirroring
   *  the same gate the Evaluation tab uses. */
  evaluationEngineConfigured?: boolean;
  /** Disables Evaluate/Retry with an explanatory tooltip once the shared
   *  monthly Azure quota is used up — mirrors the Evaluation tab's own
   *  quota.limitReached gate. */
  evaluationLimitReached?: boolean;
  /** Six-value evaluation lifecycle (shared with the Evaluation tab so the
   *  two surfaces never disagree) — drives the third center button's icon,
   *  label, and enabled state. See evaluationFeedback.ts. */
  evaluationUiState?: EvaluationUiState;
  /** Azure's own PronScore for the current sentence's last successful
   *  evaluation — only used to render the score badge in the "success"
   *  state. */
  latestScore?: number | null;
  /** Evaluate (idle/new-recording states) or Retry (error state). */
  onTriggerEvaluation?: () => void;
  /** Score badge click (success state) — opens the Evaluation tab without
   *  starting a new network request. */
  onOpenEvaluationDetails?: () => void;
}) {
  // Dictation is the only mode with a typed-answer flow (Hint, combo streak,
  // accuracy). Listening and Shadowing both instead share a generic
  // elapsed-time control surface here — each mode's own recorder/transcript
  // UI lives in the transcript stage, not here.
  const isDictationMode = inputMode === "dictation";
  const isSpeakingMode = inputMode === "shadowing";
  const isRecording = recorderStatus === "recording";
  const ModeIcon = MODE_ICONS[inputMode];
  const [showVisibilityPopover, setShowVisibilityPopover] = useState(false);
  const visibilityPopoverRef = useRef<HTMLDivElement>(null);
  const [showModePopover, setShowModePopover] = useState(false);
  const modePopoverRef = useRef<HTMLDivElement>(null);
  const [showSpeedPopover, setShowSpeedPopover] = useState(false);
  const speedPopoverRef = useRef<HTMLDivElement>(null);
  // Desktop's speed control is a separate trigger/popover from mobile's (only
  // one row is ever visible at a given viewport width, but both stay mounted
  // in the DOM, so they need independent state/refs rather than sharing one).
  const [showSpeedPopoverDesktop, setShowSpeedPopoverDesktop] = useState(false);
  const speedPopoverDesktopRef = useRef<HTMLDivElement>(null);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  useEffect(() => {
    if (!showVisibilityPopover && !showModePopover && !showSpeedPopover && !showSpeedPopoverDesktop) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (visibilityPopoverRef.current && !visibilityPopoverRef.current.contains(event.target as Node)) {
        setShowVisibilityPopover(false);
      }
      if (modePopoverRef.current && !modePopoverRef.current.contains(event.target as Node)) {
        setShowModePopover(false);
      }
      if (speedPopoverRef.current && !speedPopoverRef.current.contains(event.target as Node)) {
        setShowSpeedPopover(false);
      }
      if (speedPopoverDesktopRef.current && !speedPopoverDesktopRef.current.contains(event.target as Node)) {
        setShowSpeedPopoverDesktop(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setShowVisibilityPopover(false);
      setShowModePopover(false);
      setShowSpeedPopover(false);
      setShowSpeedPopoverDesktop(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [showVisibilityPopover, showModePopover, showSpeedPopover, showSpeedPopoverDesktop]);

  // Evaluate/score-badge/Retry — the third Shadowing-only center button.
  // Reuses ControlButton's fixed square footprint (same trick already used
  // by the playback-speed button, whose icon slot is a text span rather
  // than a Lucide icon) so swapping between Evaluate/Evaluating/a numeric
  // score/Retry never changes this button's width — see "Shadowing
  // Evaluation Improvement Plan" Part B §B9.
  const evaluateButton = evaluationEngineConfigured ? (
    evaluationUiState === "success" ? (
      <ControlButton
        icon={<span className="text-sm font-bold leading-none">{latestScore !== null ? Math.round(latestScore) : "—"}</span>}
        shortcut="Open evaluation details — Shift + D"
        label={latestScore !== null ? `${Math.round(latestScore)}` : "Score"}
        ariaLabel={
          latestScore !== null
            ? `Pronunciation score ${Math.round(latestScore)} out of 100. Open evaluation details.`
            : "Pronunciation evaluation ready. Open evaluation details."
        }
        success
        onClick={onOpenEvaluationDetails}
      />
    ) : (
      <ControlButton
        icon={
          evaluationUiState === "evaluating" ? (
            <Loader2 size={18} className="animate-spin" />
          ) : evaluationUiState === "error" ? (
            <RotateCcw size={18} />
          ) : (
            <Gauge size={18} />
          )
        }
        shortcut={
          evaluationUiState === "evaluating"
            ? "Evaluating pronunciation…"
            : evaluationLimitReached
              ? "Monthly free evaluation limit reached"
              : evaluationUiState === "error"
                ? "Retry evaluation — Shift + E"
                : !recordingClip
                  ? "Record yourself first"
                  : "Evaluate pronunciation — Shift + E"
        }
        label={evaluationUiState === "evaluating" ? "Evaluating…" : evaluationUiState === "error" ? "Retry" : "Evaluate"}
        onClick={onTriggerEvaluation}
        disabled={evaluationUiState === "evaluating" || evaluationUiState === "no-recording" || evaluationLimitReached}
      />
    )
  ) : null;

  const centerButton = isSpeakingMode ? (
    <>
      <ControlButton
        icon={isRecording ? <MiniLevelMeter level={recorderLevel} /> : <Mic size={18} />}
        shortcut={isRecording ? `Stop recording — ${formatClockTime(recorderElapsedSec)}` : "Record — R"}
        label={isRecording ? `Stop · ${formatClockTime(recorderElapsedSec)}` : "Record"}
        recording={isRecording}
        onClick={isRecording ? onStopRecording : onStartRecording}
      />
      <ControlButton
        icon={isPlayingMyRecording ? <Pause size={18} /> : <Play size={18} />}
        shortcut={isPlayingMyRecording ? "Pause my recording — Shift + P" : "Play my recording — Shift + P"}
        label={isPlayingMyRecording ? "Pause mine" : "Play mine"}
        active={isPlayingMyRecording}
        disabled={!recordingClip}
        onClick={onToggleMyRecordingPlayback}
      />
      {evaluateButton}
    </>
  ) : !isDictationMode ? (
    <ControlButton
      icon={isVideoPlaying ? <Pause size={18} /> : <Play size={18} />}
      shortcut="Play/Pause video"
      label={isVideoPlaying ? "Pause" : "Play"}
      onClick={onTogglePlayback}
    />
  ) : (
    <ControlButton
      icon={<Lightbulb size={18} />}
      shortcut="Hint"
      label="Hint"
      active={showHintPanel}
      onClick={onToggleHint}
    />
  );

  const timeStatusText =
    totalSegments > 0
      ? !isDictationMode
        ? `${formatClockTime(currentTimeSec)} / ${formatClockTime(durationSec)}`
        : `${accuracy}% accuracy`
      : "";

  return (
    <div className="flex-shrink-0 min-h-14 rounded-[18px] border border-[var(--border)] bg-[var(--surface)]">
      {/* Mobile (<768px): a single row — the sentence counter, primary
          transport controls, playback speed, and streak count all fit on
          one line; anything lower-priority (Reset, time/status, subtitle
          visibility) lives in the "More" sheet instead. */}
      <div className="flex md:hidden items-center gap-1 px-1.5 py-1.5">
        <span className="shrink-0 min-w-0 truncate text-[11px] font-semibold text-[var(--text-muted)] tabular-nums">
          {totalSegments > 0 ? `${currentSegIdx + 1}/${totalSegments}` : "—"}
        </span>
        <div className="flex flex-1 items-center justify-center gap-1">
          <ControlButton
            icon={<SkipBack size={16} />}
            shortcut="Previous sentence — Shift + ←"
            label="Prev"
            onClick={onPrevious}
            disabled={prevDisabled}
          />
          <ControlButton
            icon={<Repeat size={16} />}
            shortcut="Replay current sentence — Shift + Space"
            label="Replay"
            primary
            onClick={onReplay}
          />
          {centerButton}
          <ControlButton
            icon={<SkipForward size={16} />}
            shortcut="Next sentence — Shift + →"
            label="Next"
            onClick={onNext}
            disabled={nextDisabled}
          />
          <div className="relative">
            <ControlButton
              icon={<span className="text-[11px] font-bold leading-none">{playbackRate}×</span>}
              shortcut="Playback speed"
              label={`${playbackRate}×`}
              active={showSpeedPopover}
              onClick={() => setShowSpeedPopover((v) => !v)}
            />
            {showSpeedPopover && (
              <div
                ref={speedPopoverRef}
                className="absolute bottom-full right-0 z-50 mb-2 flex gap-1 rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] p-1.5 shadow-2xl"
              >
                {PLAYBACK_RATE_OPTIONS.map((rate) => (
                  <button
                    key={rate}
                    onClick={() => {
                      setPlaybackRate(rate);
                      setShowSpeedPopover(false);
                    }}
                    className={clsx(
                      "rounded-lg px-2.5 py-2 text-xs font-semibold transition-colors",
                      playbackRate === rate
                        ? "bg-[var(--accent)] text-[#1a1206]"
                        : "text-[var(--text-muted)] hover:bg-white/10"
                    )}
                  >
                    {rate}×
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {isDictationMode && (
          <div className="shrink-0">
            <ComboStreak combo={combo} />
          </div>
        )}
        <ControlButton
          icon={<MoreHorizontal size={16} />}
          shortcut="More controls"
          label="More"
          active={showMoreMenu}
          onClick={() => setShowMoreMenu(true)}
        />
      </div>

      {/* md and up (tablet/desktop): single-row layout. */}
      <div className="hidden md:grid md:grid-cols-[1fr_auto_1fr] md:items-center md:gap-3 md:px-4 md:py-1.5">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3 justify-self-start">
          <button
            onClick={onReset}
            title="Reset this sentence's attempt"
            aria-label="Reset attempt"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] hover:bg-white/10 transition-colors"
          >
            <RotateCcw size={14} />
          </button>
          <span className="min-w-0 truncate text-[11px] sm:text-xs font-medium text-[var(--text-muted)] tabular-nums">
            {totalSegments > 0 ? (
              !isDictationMode ? (
                <span>
                  {currentSegIdx + 1} / {totalSegments} · {formatClockTime(currentTimeSec)} / {formatClockTime(durationSec)}
                </span>
              ) : (
                <span>
                  {currentSegIdx + 1} / {totalSegments} · Accuracy {accuracy}%
                </span>
              )
            ) : (
              "—"
            )}
          </span>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 justify-self-center">
          <ControlButton
            icon={<SkipBack size={18} />}
            shortcut="Previous sentence — Shift + ←"
            label="Prev"
            onClick={onPrevious}
            disabled={prevDisabled}
          />
          <ControlButton
            icon={<Repeat size={18} />}
            shortcut="Replay current sentence — Shift + Space"
            label="Replay"
            primary
            onClick={onReplay}
          />
          {centerButton}
          <ControlButton
            icon={<SkipForward size={18} />}
            shortcut="Next sentence — Shift + →"
            label="Next"
            onClick={onNext}
            disabled={nextDisabled}
          />
        </div>

        <div className="flex min-w-0 items-center gap-1 sm:gap-2 justify-self-end">
          {isDictationMode && <ComboStreak combo={combo} />}
          <div className="relative">
            <ControlButton
              icon={<Eye size={18} />}
              shortcut="Subtitle visibility"
              label="Visibility"
              active={showVisibilityPopover}
              onClick={() => setShowVisibilityPopover((v) => !v)}
            />
            {showVisibilityPopover && (
              <div ref={visibilityPopoverRef} className="absolute bottom-full right-0 z-50 mb-2">
                <SubtitleVisibilityPopup
                  subtitleVisibility={subtitleVisibility}
                  setOriginalVisibility={setOriginalVisibility}
                  setTranslationVisibility={setTranslationVisibility}
                />
              </div>
            )}
          </div>
          <div className="relative">
            <ControlButton
              icon={<span className="text-[11px] font-bold leading-none">{playbackRate}×</span>}
              shortcut="Playback speed"
              label={`${playbackRate}×`}
              active={showSpeedPopoverDesktop}
              onClick={() => setShowSpeedPopoverDesktop((v) => !v)}
            />
            {showSpeedPopoverDesktop && (
              <div
                ref={speedPopoverDesktopRef}
                className="absolute bottom-full right-0 z-50 mb-2 flex gap-1 rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] p-1.5 shadow-2xl"
              >
                {PLAYBACK_RATE_OPTIONS.map((rate) => (
                  <button
                    key={rate}
                    onClick={() => {
                      setPlaybackRate(rate);
                      setShowSpeedPopoverDesktop(false);
                    }}
                    className={clsx(
                      "rounded-lg px-2.5 py-2 text-xs font-semibold transition-colors",
                      playbackRate === rate
                        ? "bg-[var(--accent)] text-[#1a1206]"
                        : "text-[var(--text-muted)] hover:bg-white/10"
                    )}
                  >
                    {rate}×
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="relative">
            <ControlButton
              icon={<ModeIcon size={18} />}
              shortcut={`Switch mode — currently ${INPUT_MODE_LABELS[inputMode]}`}
              label={INPUT_MODE_LABELS[inputMode]}
              active
              onClick={() => setShowModePopover((v) => !v)}
            />
            {showModePopover && (
              <div ref={modePopoverRef} className="absolute bottom-full right-0 z-50 mb-2">
                <ModeSwitcher
                  inputMode={inputMode}
                  onSelectMode={(mode) => {
                    onSelectInputMode(mode);
                    setShowModePopover(false);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <MobileBottomSheet open={showMoreMenu} onClose={() => setShowMoreMenu(false)} title="More controls">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm font-medium text-[var(--text-muted)] tabular-nums">
            <span>Sentence {totalSegments > 0 ? `${currentSegIdx + 1} / ${totalSegments}` : "—"}</span>
            {timeStatusText && <span>{timeStatusText}</span>}
          </div>
          <button
            type="button"
            onClick={() => {
              onReset();
              setShowMoreMenu(false);
            }}
            className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-glass)] px-4 py-3 text-sm font-semibold text-[var(--text-muted)] transition-colors hover:bg-white/10"
          >
            <RotateCcw size={16} /> Reset this sentence&apos;s attempt
          </button>
          <div className="flex justify-center">
            <SubtitleVisibilityPopup
              subtitleVisibility={subtitleVisibility}
              setOriginalVisibility={setOriginalVisibility}
              setTranslationVisibility={setTranslationVisibility}
            />
          </div>
        </div>
      </MobileBottomSheet>
    </div>
  );
}
