"use client";

import { useEffect } from "react";
import { AlertCircle, Mic, Play, RotateCcw, Square } from "lucide-react";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { AudioLevelMeter } from "@/components/AudioLevelMeter";

const MAX_RECORDING_SEC = 20;

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

const ERROR_MESSAGES: Record<string, string> = {
  "permission-denied": "Microphone access was denied. Allow microphone access in your browser's site settings, then try again.",
  "no-microphone": "No microphone was found on this device.",
  unsupported: "Recording isn't supported in this browser.",
  unknown: "Couldn't access the microphone. Please try again.",
};

interface PracticeRecorderPanelProps {
  mode: keyof typeof COPY;
  currentSegment: { text: string } | undefined;
  onPlayOriginal: () => void;
}

/**
 * Phase 1/2 prototype shared by ShadowingPanel and PronunciationPanel: play
 * the original sentence, record/stop, play the recording back. No countdown,
 * no self-comparison metrics, no save/evaluate yet — those land in Phase 3/4
 * (Shadowing) and Phase 6/7 (Pronunciation Practice); see "Shadowing and
 * Pronunciation Practice Plan.md".
 */
export function PracticeRecorderPanel({ mode, currentSegment, onPlayOriginal }: PracticeRecorderPanelProps) {
  const { status, error, elapsedSec, level, clip, start, stop, discard } = useAudioRecorder({
    maxDurationSec: MAX_RECORDING_SEC,
  });
  const copy = COPY[mode];

  // A recorded take only ever refers to the sentence it was made for —
  // moving to a different sentence must not leave a stale playback around.
  useEffect(() => {
    discard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSegment?.text]);

  const isRecording = status === "recording";
  const hasClip = status === "stopped" && !!clip;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto px-4 py-3 text-center">
      <div>
        <p className="text-sm font-semibold text-[var(--text)]">{copy.title}</p>
        <p className="mt-1 max-w-sm text-xs text-[var(--text-muted)]">{copy.hint}</p>
      </div>

      <button
        type="button"
        onClick={onPlayOriginal}
        disabled={!currentSegment}
        className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-glass)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Play size={15} /> Hear it
      </button>

      <div className="flex min-h-[72px] flex-col items-center justify-center gap-2">
        {isRecording ? (
          <>
            <AudioLevelMeter level={level} active />
            <span className="text-xs font-medium tabular-nums text-[var(--text-muted)]">
              {elapsedSec.toFixed(1)}s / {MAX_RECORDING_SEC}s
            </span>
            <button
              type="button"
              onClick={stop}
              className="flex items-center gap-2 rounded-full bg-[var(--red)] px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-105"
            >
              <Square size={14} className="fill-white" /> Stop
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            disabled={status === "requesting-permission"}
            className="flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[#1a1206] shadow-lg transition-transform hover:scale-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Mic size={16} /> {status === "requesting-permission" ? "Requesting mic…" : hasClip ? "Record again" : "Record"}
          </button>
        )}
      </div>

      {status === "error" && error && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-[var(--red)]">
          <AlertCircle size={13} /> {ERROR_MESSAGES[error]}
        </p>
      )}

      {hasClip && clip && (
        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
          <audio controls src={clip.url} className="h-9" />
          <p className="text-[10px] text-[var(--text-faint)] tabular-nums">
            {clip.durationSec.toFixed(1)}s · {clip.mimeType}
          </p>
          <button
            type="button"
            onClick={discard}
            className="flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--accent)]"
          >
            <RotateCcw size={11} /> Discard
          </button>
        </div>
      )}
    </div>
  );
}
