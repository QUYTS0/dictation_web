"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, Lightbulb, RotateCcw, SkipBack, SkipForward, Repeat, Volume2, VolumeX, LayoutGrid } from "lucide-react";
import { ControlButton } from "./ControlButton";
import { ComboStreak } from "./ComboStreak";
import { SubtitleVisibilityPopup } from "./SubtitleVisibilityPopup";
import { ModeSwitcher } from "./ModeSwitcher";
import type { SubtitleVisibility, SubtitleVisibilityState } from "../types";

export function ControlBar({
  videoId,
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
}: {
  videoId: string;
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
}) {
  const [showVisibilityPopover, setShowVisibilityPopover] = useState(false);
  const visibilityPopoverRef = useRef<HTMLDivElement>(null);
  const [showModePopover, setShowModePopover] = useState(false);
  const modePopoverRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="flex-shrink-0 min-h-14 rounded-[18px] border border-[var(--border)] bg-[var(--surface)] grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-3 px-2.5 sm:px-4 py-1.5">
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
            <>
              <span className="sm:hidden">
                {currentSegIdx + 1}/{totalSegments} · {accuracy}%
              </span>
              <span className="hidden sm:inline">
                {currentSegIdx + 1} / {totalSegments} · Accuracy {accuracy}%
              </span>
            </>
          ) : (
            "—"
          )}
        </span>
      </div>

      <div className="flex items-center gap-1 sm:gap-2 justify-self-center">
        <ControlButton icon={<SkipBack size={18} />} shortcut="Shift + <-" label="Prev" onClick={onPrevious} disabled={prevDisabled} />
        <ControlButton icon={<Repeat size={18} />} shortcut="Shift + Space" label="Replay" primary onClick={onReplay} />
        <ControlButton
          icon={<Lightbulb size={18} />}
          shortcut="Hint"
          label="Hint"
          active={showHintPanel}
          onClick={onToggleHint}
        />
        <ControlButton icon={<SkipForward size={18} />} shortcut="Shift + ->" label="Next" onClick={onNext} disabled={nextDisabled} />
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
            label="Mode"
            active
            onClick={() => setShowModePopover((v) => !v)}
          />
          {showModePopover && (
            <div ref={modePopoverRef} className="absolute bottom-full right-0 z-50 mb-2">
              <ModeSwitcher videoId={videoId} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
