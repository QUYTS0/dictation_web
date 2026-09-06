"use client";

import { useEffect, useRef } from "react";
import { clsx } from "clsx";
import { Mic, Sparkles, Volume2, VolumeX, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { DICTATION_SHORTCUTS, GENERAL_SHORTCUTS, SHADOWING_SHORTCUTS } from "../constants";
import { ModeSwitcher } from "./ModeSwitcher";
import type { PracticeQuotaState } from "../usePracticeEvaluation";
import type { InputMode, ShortcutEntry } from "../types";

/** Compact "{h}h {m}m"/"{m}m {ss}s"/"{s}s" duration — mirrors the same
 *  formatter used in EvaluationTab so the two Azure-usage surfaces (the
 *  short inline line in the Evaluation tab and this full breakdown) always
 *  read the same way. */
function formatCompactDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    return remSeconds === 0 ? `${minutes}m` : `${minutes}m ${remSeconds.toString().padStart(2, "0")}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const remMinutes = Math.floor((seconds % 3600) / 60);
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

function ShortcutGroup({ title, shortcuts }: { title: string; shortcuts: ShortcutEntry[] }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">{title}</p>
      <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.keys + shortcut.label} className="flex items-center justify-between gap-3 text-xs">
            <span className="text-[var(--text-muted)]">{shortcut.label}</span>
            <kbd className="shrink-0 rounded border border-[var(--border-strong)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--text-muted)]">
              {shortcut.keys}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
import type { PracticeMode, VideoSizeMode } from "../types";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Settings drawer consolidating controls that don't need to be one tap away:
 * Audio mode, Zen mode, video size, auto-advance, practice mode, input mode
 * (Dictation/Listening), and the sound-effect toggle. Playback speed lives
 * on the control bar itself instead — it's used often enough to want in one tap.
 * Renders as a floating right-side panel on desktop/tablet and (via the
 * same positioning classes, which collapse to a near-full-width card below
 * `md`) a full-width panel on mobile, where it's reached from the top nav's
 * Settings button.
 */
export function SettingsDrawer({
  open,
  onClose,
  showVideo,
  onToggleAudioMode,
  onActivateZenMode,
  videoSizeMode,
  setVideoSizeMode,
  autoAdvance,
  setAutoAdvance,
  practiceMode,
  setPracticeMode,
  inputMode,
  onSelectInputMode,
  soundEnabled,
  onToggleSound,
  autoWordMatch,
  onToggleAutoWordMatch,
  practiceQuota,
  regenerateTranslation,
  regeneratingTranslation,
  regenerateTranslationError,
  onRegenerateScript,
  regenerating,
  regenerateError,
  onLoadSrtFile,
  srtParsing,
  srtUploadError,
}: {
  open: boolean;
  onClose: () => void;
  showVideo: boolean;
  onToggleAudioMode: () => void;
  onActivateZenMode: () => void;
  videoSizeMode: VideoSizeMode;
  setVideoSizeMode: (mode: VideoSizeMode) => void;
  autoAdvance: boolean;
  setAutoAdvance: (updater: (prev: boolean) => boolean) => void;
  practiceMode: PracticeMode;
  setPracticeMode: (mode: PracticeMode) => void;
  inputMode: InputMode;
  onSelectInputMode: (mode: InputMode) => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  autoWordMatch: boolean;
  onToggleAutoWordMatch: () => void;
  /** Optional — undefined when Shadowing/Azure isn't relevant to the caller.
   *  Drives the "Pronunciation evaluation usage" breakdown below. */
  practiceQuota?: PracticeQuotaState;
  regenerateTranslation: () => void;
  regeneratingTranslation: boolean;
  regenerateTranslationError: string | null;
  onRegenerateScript: () => void;
  regenerating: boolean;
  regenerateError: string | null;
  onLoadSrtFile: () => void;
  srtParsing: boolean;
  srtUploadError: string | null;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;

      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[70] bg-black/50"
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-drawer-title"
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ type: "tween", ease: "easeOut", duration: 0.25 }}
            className="fixed right-4 top-4 bottom-4 z-[75] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-5 overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl backdrop-blur-xl text-[var(--text)]"
          >
            <div className="flex items-center justify-between">
              <h2 id="settings-drawer-title" className="text-sm font-semibold text-[var(--text)]">
                Settings
              </h2>
              <button
                type="button"
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-white/10"
                aria-label="Close settings"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <button
                onClick={onToggleAudioMode}
                className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-glass)] px-3 py-2 text-xs font-bold text-[var(--text-muted)] hover:bg-white/10 transition-colors"
              >
                <Sparkles size={14} className="text-[var(--accent)]" />
                {showVideo ? "Audio Mode" : "Exit Audio Mode"}
              </button>
              <button
                onClick={onActivateZenMode}
                className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-glass)] px-3 py-2 text-xs font-bold text-[var(--text-muted)] hover:bg-white/10 transition-colors"
              >
                <Sparkles size={14} className="text-[var(--accent)]" />
                Zen Mode
              </button>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Video size</p>
              <div className="flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] p-1 shadow-sm">
                <button
                  onClick={() => setVideoSizeMode("standard")}
                  className={clsx(
                    "flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                    videoSizeMode === "standard" ? "bg-[var(--accent)] text-[#1a1206]" : "text-[var(--text-muted)] hover:bg-white/10"
                  )}
                >
                  Standard
                </button>
                <button
                  onClick={() => setVideoSizeMode("large")}
                  className={clsx(
                    "flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                    videoSizeMode === "large" ? "bg-[var(--accent)] text-[#1a1206]" : "text-[var(--text-muted)] hover:bg-white/10"
                  )}
                >
                  Large
                </button>
              </div>
            </div>

            <button
              onClick={() => setAutoAdvance((v) => !v)}
              title="Auto-submit as soon as your typed text matches the sentence"
              className={clsx(
                "flex items-center justify-between rounded-xl border px-4 py-3 text-sm font-semibold transition-colors",
                autoAdvance
                  ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)]"
              )}
            >
              <span className="flex items-center gap-2">
                <Sparkles size={16} className="text-[var(--accent)]" />
                Auto-advance
              </span>
              <span>{autoAdvance ? "On" : "Off"}</span>
            </button>

            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Practice mode</p>
              <div
                className="flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] p-1 shadow-sm"
                title="Easy mode always shows the sentence's word/letter shape. Hard mode hides it until you ask for a hint."
              >
                <button
                  onClick={() => setPracticeMode("easy")}
                  className={clsx(
                    "flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                    practiceMode === "easy" ? "bg-[var(--accent)] text-[#1a1206]" : "text-[var(--text-muted)] hover:bg-white/10"
                  )}
                >
                  Easy
                </button>
                <button
                  onClick={() => setPracticeMode("hard")}
                  className={clsx(
                    "flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                    practiceMode === "hard" ? "bg-[var(--accent)] text-[#1a1206]" : "text-[var(--text-muted)] hover:bg-white/10"
                  )}
                >
                  Hard
                </button>
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Script</p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={regenerateTranslation}
                  disabled={regeneratingTranslation}
                  title="Re-translate this video's script if the Vietnamese doesn't match the English"
                  className="rounded-lg border border-[var(--accent-border)] bg-[var(--accent-soft)] px-3 py-2 text-xs font-semibold text-[var(--accent)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {regeneratingTranslation ? "Regenerating translation…" : "Regenerate translation"}
                </button>
                <button
                  onClick={onRegenerateScript}
                  disabled={regenerating}
                  title="Re-fetch this video's script from YouTube's captions if it doesn't match the audio"
                  className="rounded-lg border border-[var(--accent-border)] bg-[var(--accent-soft)] px-3 py-2 text-xs font-semibold text-[var(--accent)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {regenerating ? "Regenerating…" : "Regenerate script"}
                </button>
                <button
                  onClick={onLoadSrtFile}
                  disabled={srtParsing}
                  title="Replace this video's script by loading a .srt subtitle file"
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-semibold text-[var(--text-muted)] hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {srtParsing ? "Loading…" : "📄 Load .srt file"}
                </button>
                {regenerateError && <p className="text-xs text-[var(--red)]">{regenerateError}</p>}
                {srtUploadError && <p className="text-xs text-[var(--red)]">{srtUploadError}</p>}
                {regenerateTranslationError && <p className="text-xs text-[var(--red)]">{regenerateTranslationError}</p>}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Practice input mode</p>
              <ModeSwitcher inputMode={inputMode} onSelectMode={onSelectInputMode} />
            </div>

            <button
              onClick={onToggleSound}
              className={clsx(
                "flex items-center justify-between rounded-xl border px-4 py-3 text-sm font-semibold transition-colors",
                soundEnabled
                  ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)]"
              )}
            >
              <span className="flex items-center gap-2">
                {soundEnabled ? <Volume2 size={16} className="text-[var(--accent)]" /> : <VolumeX size={16} />}
                Sound effects
              </span>
              <span>{soundEnabled ? "On" : "Off"}</span>
            </button>

            <div className="flex flex-col gap-1.5">
              <button
                onClick={onToggleAutoWordMatch}
                className={clsx(
                  "flex items-center justify-between rounded-xl border px-4 py-3 text-sm font-semibold transition-colors",
                  autoWordMatch
                    ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)]"
                )}
              >
                <span className="flex items-center gap-2">
                  <Mic size={16} className={autoWordMatch ? "text-[var(--accent)]" : undefined} />
                  Auto Word Match
                </span>
                <span>{autoWordMatch ? "On" : "Off"}</span>
              </button>
              <p className="px-1 text-[11px] leading-snug text-[var(--text-faint)]">
                In Shadowing, automatically compares what your browser&apos;s speech recognition heard against the
                script right after you record. Uses your browser&apos;s built-in (vendor) speech service — free, but
                not available in every browser.
              </p>
            </div>

            {practiceQuota?.engineConfigured && (
              <div className="flex flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
                <p className="text-xs font-semibold text-[var(--text)]">Pronunciation evaluation usage</p>
                <p className="text-sm font-semibold text-[var(--text)] tabular-nums">
                  {formatCompactDuration(practiceQuota.usedSec)} / {formatCompactDuration(practiceQuota.limitSec)} this
                  month
                </p>
                <p className="text-[11px] leading-snug text-[var(--text-faint)]">
                  Shared across everyone using this site, not tracked per person or device — the monthly free Azure
                  Pronunciation Assessment quota resets at the start of each calendar month.
                </p>
              </div>
            )}

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">
                Keyboard shortcuts
              </p>
              <div className="flex flex-col gap-4">
                <ShortcutGroup title="Dictation" shortcuts={DICTATION_SHORTCUTS} />
                <ShortcutGroup title="Shadowing" shortcuts={SHADOWING_SHORTCUTS} />
                <ShortcutGroup title="General" shortcuts={GENERAL_SHORTCUTS} />
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
