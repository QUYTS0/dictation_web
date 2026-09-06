import { useEffect, useState } from "react";

interface UseKeyboardShortcutsOptions {
  onReplay: () => void;
  onPrevious: () => void;
  onSkip: () => void;
  onTogglePlayback: () => void;
  /** Space play/pause applies to every non-dictation mode (Listening,
   *  Shadowing) — the modes where ControlBar's center button isn't Hint. In
   *  Shadowing that center button is Record/Stop rather than Play/Pause, but
   *  Space still toggles the video itself, which stays independently useful
   *  there. */
  isListeningMode: boolean;
  isZenMode: boolean;
  onZenModeChange: (value: boolean | ((prev: boolean) => boolean)) => void;
  /** Shadowing-only shortcuts (Record, Play my recording, Evaluate, Open
   *  evaluation details) — all optional and all gated on isShadowingMode so
   *  passing nothing is safe for Dictation/Listening callers. See
   *  "Shadowing Evaluation Improvement Plan" Part B §B10. */
  isShadowingMode?: boolean;
  onToggleRecording?: () => void;
  onToggleMyRecordingPlayback?: () => void;
  onEvaluate?: () => void;
  onOpenEvaluationDetails?: () => void;
}

/**
 * Wires the dictation page's global keyboard shortcuts (Space play/pause in
 * Listening Mode, Shift+Space replay, Shift+Arrow prev/next, "/" to focus the
 * answer input, "Z" to toggle Zen mode, Escape to exit it, and — in Shadowing
 * — R / Shift+P / Shift+E / Shift+D for Record / Play my recording / Evaluate
 * / Open evaluation details). Returns a signal that increments each time "/"
 * is pressed, so the page can focus its input.
 */
export function useKeyboardShortcuts({
  onReplay,
  onPrevious,
  onSkip,
  onTogglePlayback,
  isListeningMode,
  isZenMode,
  onZenModeChange,
  isShadowingMode = false,
  onToggleRecording,
  onToggleMyRecordingPlayback,
  onEvaluate,
  onOpenEvaluationDetails,
}: UseKeyboardShortcutsOptions) {
  const [inputFocusSignal, setInputFocusSignal] = useState(0);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (e.key === "Escape" && isZenMode) {
        e.preventDefault();
        onZenModeChange(false);
        return;
      }

      // Shift+Space (replay) takes priority over the answer input's own plain-Space
      // word-advance handler. Handled once here on keydown; stopping propagation keeps
      // it from being reinterpreted by anything else the event might still reach.
      if (e.shiftKey && e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        onReplay();
        return;
      }

      // Plain Space toggles Play/Pause, but only outside Dictation (the only
      // mode without a Play/Pause control), outside typing targets (so it
      // doesn't fight the answer input's own Space handling), and never on a
      // key-repeat (so holding Space doesn't rapidly toggle playback).
      if (
        isListeningMode &&
        !isTypingTarget &&
        !e.repeat &&
        e.code === "Space" &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        onTogglePlayback();
        return;
      }

      if (e.shiftKey && e.key === "ArrowLeft") {
        e.preventDefault();
        onPrevious();
        return;
      }

      if (e.shiftKey && e.key === "ArrowRight") {
        e.preventDefault();
        onSkip();
        return;
      }

      if (!isTypingTarget && e.key === "/") {
        e.preventDefault();
        setInputFocusSignal((v) => v + 1);
        return;
      }

      if (
        !isTypingTarget &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.toLowerCase() === "z"
      ) {
        e.preventDefault();
        onZenModeChange((prev) => !prev);
        return;
      }

      if (isShadowingMode && !isTypingTarget && !e.repeat) {
        // Record/Stop — bare "R", distinct from any Shift-chord shortcut
        // since it's a lower-stakes, frequently-used action (mirrors the
        // existing bare "Z" convention for Zen mode).
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "r" && onToggleRecording) {
          e.preventDefault();
          onToggleRecording();
          return;
        }
        // Play/Pause my recording — Shift+P, distinct from plain Space
        // (which plays/pauses the source video, not the user's own take) so
        // the two are never confused.
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "p" && onToggleMyRecordingPlayback) {
          e.preventDefault();
          onToggleMyRecordingPlayback();
          return;
        }
        // Evaluate/Retry — Shift+E, a deliberate Shift-chord (matching
        // Shift+Space/Shift+Arrow) since it can send audio to Azure.
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "e" && onEvaluate) {
          e.preventDefault();
          onEvaluate();
          return;
        }
        // Open evaluation details (the score badge's action) — Shift+D.
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "d" && onOpenEvaluationDetails) {
          e.preventDefault();
          onOpenEvaluationDetails();
          return;
        }
      }

      if (isTypingTarget) return;
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    onReplay,
    onSkip,
    onPrevious,
    onTogglePlayback,
    isListeningMode,
    isZenMode,
    onZenModeChange,
    isShadowingMode,
    onToggleRecording,
    onToggleMyRecordingPlayback,
    onEvaluate,
    onOpenEvaluationDetails,
  ]);

  return { inputFocusSignal };
}
