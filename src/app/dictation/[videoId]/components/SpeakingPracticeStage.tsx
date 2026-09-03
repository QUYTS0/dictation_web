"use client";

import { AlertCircle, Check, Mic, Play, RotateCcw } from "lucide-react";
import type { AudioRecorderErrorReason, AudioRecorderStatus, RecordedClip } from "@/hooks/useAudioRecorder";
import { CompactAudioPlayer } from "@/components/CompactAudioPlayer";
import { AudioLevelMeter } from "@/components/AudioLevelMeter";

const COPY = {
  shadowing: {
    title: "Shadowing",
    hint: "Play the sentence, then record yourself repeating it back — match the rhythm and timing, not the exact wording.",
  },
  pronunciation: {
    title: "Pronunciation Practice",
    hint: "Play the sentence, then record yourself reading it aloud alone.",
  },
} as const;

const ERROR_MESSAGES: Record<AudioRecorderErrorReason, string> = {
  "permission-denied": "Microphone access denied.",
  "no-microphone": "No microphone found.",
  unsupported: "Recording isn't supported here.",
  unknown: "Couldn't access the microphone.",
};

export interface SpeakingPracticeStageProps {
  mode: keyof typeof COPY;
  currentSegment: { text: string } | undefined;
  onPlayOriginal: () => void;
  translationText: string | undefined;
  showTranslation: boolean;
  status: AudioRecorderStatus;
  error: AudioRecorderErrorReason | null;
  elapsedSec: number;
  level: number;
  clip: RecordedClip | null;
  onStartRecording: () => void;
}

/**
 * Compact, fixed-height desktop workspace (three columns: reference audio /
 * recording status / your recording) shared by ShadowingPanel and
 * PronunciationPanel, plus a stacked fallback below `lg`. Recording is
 * started/stopped from ControlBar's center button (see DefaultLayout) — this
 * component only ever *displays* recorder state and re-triggers a take via
 * "Record again"; it never owns the recorder itself, so ControlBar and this
 * stage always agree on what's happening.
 *
 * Every state (idle / recording / recorded / error) renders inside the same
 * fixed-size slots so switching between them never changes this component's
 * height — see "Shadowing and Pronunciation Practice Plan.md" and the
 * desktop-layout-refactor task for why that matters (a taller native
 * <audio controls> element used to push the shared ControlBar out of view).
 */
export function SpeakingPracticeStage({
  mode,
  currentSegment,
  onPlayOriginal,
  translationText,
  showTranslation,
  status,
  error,
  elapsedSec,
  level,
  clip,
  onStartRecording,
}: SpeakingPracticeStageProps) {
  const copy = COPY[mode];
  const isRecording = status === "recording";
  const hasClip = status === "stopped" && !!clip;

  return (
    <div className="flex h-full flex-col gap-2 lg:max-h-[220px] lg:gap-1.5 lg:overflow-hidden">
      <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 lg:gap-4">
        {/* Column 1 — reference audio: static regardless of recorder state */}
        <div className="flex flex-col items-center justify-center gap-2 text-center lg:items-start lg:border-r lg:border-[var(--border)] lg:pr-4 lg:text-left">
          <div>
            <p className="text-sm font-semibold text-[var(--text)]">{copy.title}</p>
            <p className="mt-0.5 line-clamp-2 text-xs text-[var(--text-muted)]">{copy.hint}</p>
          </div>
          <button
            type="button"
            onClick={onPlayOriginal}
            disabled={!currentSegment}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-glass)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Play size={13} /> Hear it
          </button>
        </div>

        {/* Column 2 — recording status: a fixed-height slot whose content
            swaps by status, never resizing the slot itself. */}
        <div className="flex h-14 flex-col items-center justify-center gap-1 overflow-hidden lg:h-auto lg:border-r lg:border-[var(--border)] lg:pr-4">
          {isRecording ? (
            <>
              <AudioLevelMeter level={level} active />
              <span className="text-[11px] font-medium tabular-nums text-[var(--text-muted)]">{elapsedSec.toFixed(1)}s</span>
            </>
          ) : status === "error" ? (
            <span className="flex items-center gap-1 text-center text-[11px] text-[var(--red)]">
              <AlertCircle size={12} className="shrink-0" /> {error ? ERROR_MESSAGES[error] : "Recording failed."}
            </span>
          ) : hasClip && clip ? (
            <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--green)]">
              <Check size={12} /> Recorded · {clip.durationSec.toFixed(1)}s
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-[var(--text-faint)]">
              <Mic size={12} /> Not recording
            </span>
          )}
        </div>

        {/* Column 3 — your recording: same fixed-height slot whether empty
            or holding the compact player + actions. */}
        <div className="flex h-16 flex-col items-center justify-center gap-1.5 lg:h-auto">
          {hasClip && clip ? (
            <>
              <CompactAudioPlayer src={clip.url} durationHint={clip.durationSec} />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onStartRecording}
                  className="flex items-center gap-1 rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:bg-white/10 hover:text-[var(--accent)]"
                >
                  <RotateCcw size={11} /> Record again
                </button>
                {/* Reserved for Phase 6-8 — non-functional until Word Match /
                    pronunciation evaluation lands. */}
                <div className="flex items-center gap-1 opacity-40" title="Coming soon">
                  <button
                    type="button"
                    disabled
                    className="cursor-not-allowed rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium text-[var(--text-faint)]"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    disabled
                    className="cursor-not-allowed rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium text-[var(--text-faint)]"
                  >
                    Evaluate
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="text-center text-[11px] text-[var(--text-faint)]">Your recording will appear here</p>
          )}
        </div>
      </div>

      {/* Reserved translation strip — fixed height whether or not there is
          translation text to show, so its presence/absence never changes
          the stage's overall height. */}
      <div className="flex h-8 shrink-0 items-center justify-center overflow-hidden px-2 lg:h-7">
        {showTranslation && translationText && (
          <p className="line-clamp-2 text-center text-[11px] leading-tight text-[var(--text-muted)]">{translationText}</p>
        )}
      </div>
    </div>
  );
}
