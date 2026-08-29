"use client";

import { useEffect, useRef } from "react";
import { clsx } from "clsx";
import { Sparkles, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { DICTATION_SHORTCUTS, GENERAL_SHORTCUTS, PLAYBACK_RATE_OPTIONS } from "../constants";
import type { ShortcutEntry } from "../types";

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
 * Desktop-only (hidden sm:block) settings drawer consolidating the controls
 * that used to live in the always-visible desktop toolbar row: Audio mode,
 * Zen mode, video size, playback rate, auto-advance, and practice mode.
 * Mobile keeps its own phone toolbar + MobileBottomSheet, unaffected.
 */
export function SettingsDrawer({
  open,
  onClose,
  showVideo,
  onToggleAudioMode,
  onActivateZenMode,
  videoSizeMode,
  setVideoSizeMode,
  playbackRate,
  setPlaybackRate,
  autoAdvance,
  setAutoAdvance,
  practiceMode,
  setPracticeMode,
}: {
  open: boolean;
  onClose: () => void;
  showVideo: boolean;
  onToggleAudioMode: () => void;
  onActivateZenMode: () => void;
  videoSizeMode: VideoSizeMode;
  setVideoSizeMode: (mode: VideoSizeMode) => void;
  playbackRate: (typeof PLAYBACK_RATE_OPTIONS)[number];
  setPlaybackRate: (rate: (typeof PLAYBACK_RATE_OPTIONS)[number]) => void;
  autoAdvance: boolean;
  setAutoAdvance: (updater: (prev: boolean) => boolean) => void;
  practiceMode: PracticeMode;
  setPracticeMode: (mode: PracticeMode) => void;
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
        <div className="hidden sm:block">
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

            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Playback speed</p>
              <div className="flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] p-1 shadow-sm">
                {PLAYBACK_RATE_OPTIONS.map((rate) => (
                  <button
                    key={rate}
                    onClick={() => setPlaybackRate(rate)}
                    className={clsx(
                      "flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                      playbackRate === rate ? "bg-[var(--accent)] text-[#1a1206]" : "text-[var(--text-muted)] hover:bg-white/10"
                    )}
                  >
                    {rate}x
                  </button>
                ))}
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
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">
                Keyboard shortcuts
              </p>
              <div className="flex flex-col gap-4">
                <ShortcutGroup title="Dictation" shortcuts={DICTATION_SHORTCUTS} />
                <ShortcutGroup title="General" shortcuts={GENERAL_SHORTCUTS} />
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
