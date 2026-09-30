"use client";

import { useEffect, useRef, type RefObject } from "react";

const RECORDING_TICK_MS = 1000;

/**
 * The practice page's qualifying learning events (plan §5.3 / §6.3b) — the
 * ONLY things, besides PLAYING playback ticks and answer submissions (both
 * reported by the page directly), that mark engaged time:
 *  - Dictation answer input: typing/editing in the answer field itself.
 *    Keys or clicks anywhere else on the page (tabs, settings, vocabulary,
 *    notes) are not practice activity;
 *  - hint use: opening the hint panel or changing its level — not the
 *    panel being closed or reset by the page;
 *  - Shadowing: once a second while a recording is actually running, and
 *    never after it stops or is cancelled.
 * Mounting, re-rendering, timers, polling and data fetching report nothing.
 */
export function usePracticeActivitySources(opts: {
  noteInteraction: () => void;
  answerInputRef: RefObject<HTMLElement | null>;
  showHintPanel: boolean;
  hintLevel: number;
  isRecording: boolean;
}) {
  const { noteInteraction, answerInputRef, showHintPanel, hintLevel, isRecording } = opts;

  useEffect(() => {
    const onAnswerInput = (event: Event) => {
      if (answerInputRef.current && event.target === answerInputRef.current) noteInteraction();
    };
    document.addEventListener("input", onAnswerInput, true);
    document.addEventListener("keydown", onAnswerInput, true);
    return () => {
      document.removeEventListener("input", onAnswerInput, true);
      document.removeEventListener("keydown", onAnswerInput, true);
    };
  }, [noteInteraction, answerInputRef]);

  const hintRef = useRef({ open: showHintPanel, level: hintLevel });
  useEffect(() => {
    const prev = hintRef.current;
    hintRef.current = { open: showHintPanel, level: hintLevel };
    if (showHintPanel && (!prev.open || prev.level !== hintLevel)) noteInteraction();
  }, [showHintPanel, hintLevel, noteInteraction]);

  useEffect(() => {
    if (!isRecording) return;
    noteInteraction();
    const timer = setInterval(noteInteraction, RECORDING_TICK_MS);
    return () => clearInterval(timer);
  }, [isRecording, noteInteraction]);
}
