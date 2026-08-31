"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, Lightbulb, MoreHorizontal, Pause, Play, RotateCcw, SkipBack, SkipForward, Repeat, Volume2, VolumeX, LayoutGrid } from "lucide-react";
import { ControlButton } from "./ControlButton";
import { ComboStreak } from "./ComboStreak";
import { SubtitleVisibilityPopup } from "./SubtitleVisibilityPopup";
import { ModeSwitcher } from "./ModeSwitcher";
import { MobileBottomSheet } from "./MobileBottomSheet";
import { formatClockTime } from "../helpers";
import type { InputMode, SubtitleVisibility, SubtitleVisibilityState } from "../types";

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
  soundEnabled,
  onToggleSound,
  subtitleVisibility,
  setOriginalVisibility,
  setTranslationVisibility,
  inputMode,
  onSelectInputMode,
  isVideoPlaying,
  onTogglePlayback,
  currentTimeSec,
  durationSec,
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
  soundEnabled: boolean;
  onToggleSound: () => void;
  subtitleVisibility: SubtitleVisibilityState;
  setOriginalVisibility: (value: SubtitleVisibility) => void;
  setTranslationVisibility: (value: SubtitleVisibility) => void;
  inputMode: InputMode;
  onSelectInputMode: (mode: InputMode) => void;
  isVideoPlaying: boolean;
  onTogglePlayback: () => void;
  currentTimeSec: number;
  durationSec: number;
}) {
  const isListeningMode = inputMode === "listening";
  const [showVisibilityPopover, setShowVisibilityPopover] = useState(false);
  const visibilityPopoverRef = useRef<HTMLDivElement>(null);
  const [showModePopover, setShowModePopover] = useState(false);
  const modePopoverRef = useRef<HTMLDivElement>(null);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  useEffect(() => {
    if (!showVisibilityPopover && !showModePopover) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (visibilityPopoverRef.current && !visibilityPopoverRef.current.contains(event.target as Node)) {
        setShowVisibilityPopover(false);
      }
      if (modePopoverRef.current && !modePopoverRef.current.contains(event.target as Node)) {
        setShowModePopover(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setShowVisibilityPopover(false);
      setShowModePopover(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [showVisibilityPopover, showModePopover]);

  const playPauseOrHintButton = isListeningMode ? (
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

  return (
    <div className="flex-shrink-0 min-h-14 rounded-[18px] border border-[var(--border)] bg-[var(--surface)]">
      {/* Phone-only (<640px) layout: the single-row grid below overlaps at this
          width, so this stacks sentence/time info on its own row and moves
          low-priority controls (Reset, Visibility, Mode) into a "More" sheet. */}
      <div className="flex flex-col gap-1.5 px-2.5 py-2 sm:hidden">
        <div className="flex items-center justify-between gap-2 px-0.5">
          <span className="min-w-0 truncate text-xs font-medium text-[var(--text-muted)] tabular-nums">
            {totalSegments > 0 ? `${currentSegIdx + 1} / ${totalSegments}` : "—"}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <span className="truncate text-xs font-medium text-[var(--text-muted)] tabular-nums">
              {totalSegments > 0
                ? isListeningMode
                  ? `${formatClockTime(currentTimeSec)} / ${formatClockTime(durationSec)}`
                  : `${accuracy}% accuracy`
                : ""}
            </span>
            <ComboStreak combo={combo} />
          </div>
        </div>
        <div className="flex items-center justify-center gap-1.5">
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
          {playPauseOrHintButton}
          <ControlButton
            icon={<SkipForward size={18} />}
            shortcut="Next sentence — Shift + →"
            label="Next"
            onClick={onNext}
            disabled={nextDisabled}
          />
          <ControlButton
            icon={soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
            shortcut="Sound"
            label={soundEnabled ? "Sound on" : "Sound off"}
            active={soundEnabled}
            onClick={onToggleSound}
          />
          <ControlButton
            icon={<MoreHorizontal size={18} />}
            shortcut="More controls"
            label="More"
            active={showMoreMenu}
            onClick={() => setShowMoreMenu(true)}
          />
        </div>
      </div>

      {/* sm and up (tablet/desktop): original single-row layout, unchanged. */}
      <div className="hidden sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-3 sm:px-4 sm:py-1.5">
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
              isListeningMode ? (
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
          {playPauseOrHintButton}
          <ControlButton
            icon={<SkipForward size={18} />}
            shortcut="Next sentence — Shift + →"
            label="Next"
            onClick={onNext}
            disabled={nextDisabled}
          />
        </div>

        <div className="flex min-w-0 items-center gap-1 sm:gap-2 justify-self-end">
          <ComboStreak combo={combo} />
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
          <ControlButton
            icon={soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
            shortcut="Sound"
            label={soundEnabled ? "Sound on" : "Sound off"}
            active={soundEnabled}
            onClick={onToggleSound}
          />
          <div className="relative">
            <ControlButton
              icon={<LayoutGrid size={18} />}
              shortcut="Switch mode"
              label={inputMode === "listening" ? "Listening" : "Dictation"}
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
          <div className="flex justify-center">
            <ModeSwitcher
              inputMode={inputMode}
              onSelectMode={(mode) => {
                onSelectInputMode(mode);
                setShowMoreMenu(false);
              }}
            />
          </div>
        </div>
      </MobileBottomSheet>
    </div>
  );
}
