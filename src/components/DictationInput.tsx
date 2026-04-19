"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { DiffToken } from "@/lib/types";

interface DictationInputProps {
  isEnabled: boolean;
  onSubmit: (text: string) => void;
  diff?: DiffToken[];
  isCorrect?: boolean | null;
  /** Number of wrong attempts for this segment */
  wrongAttempts?: number;
  /** Increment to request focus from keyboard shortcuts (e.g. "/") */
  focusSignal?: number;
  inputAriaDescribedBy?: string;
}

// Compact mask keeps feedback non-spoiling while still showing where errors exist.
const MASKED_WORD_PLACEHOLDER = "***";

function buildMaskedResult(diff: DiffToken[] | undefined) {
  if (!diff || diff.length === 0) return "";
  return diff
    .filter((token) => token.status !== "extra")
    .map((token) => (token.status === "correct" ? token.word : MASKED_WORD_PLACEHOLDER))
    .join(" ");
}

const INITIAL_FOCUS_DELAY_MS = 50;
const FOCUS_DELAY_MS = 10;

export default function DictationInput({
  isEnabled,
  onSubmit,
  diff,
  isCorrect,
  wrongAttempts = 0,
  focusSignal = 0,
  inputAriaDescribedBy,
}: DictationInputProps) {
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const maskedResult = useMemo(() => buildMaskedResult(diff), [diff]);

  const focusInput = useCallback(
    (delay = FOCUS_DELAY_MS) => window.setTimeout(() => inputRef.current?.focus(), delay),
    []
  );

  // Reset state and focus the input on mount (component is remounted per segment via key).
  useEffect(() => {
    const t = focusInput(INITIAL_FOCUS_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [focusInput]);

  useEffect(() => {
    if (!isEnabled) return;
    const t = focusInput();
    return () => window.clearTimeout(t);
  }, [focusInput, focusSignal, isEnabled]);

  const submitCurrentInput = useCallback(() => {
    const trimmed = inputText.trim();
    if (!trimmed || !isEnabled) return;
    onSubmit(trimmed);
  }, [inputText, isEnabled, onSubmit]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitCurrentInput();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p id="dictation-input-instruction" className="text-slate-500 text-xs">
          Type the full sentence, then press Enter or Check
        </p>
        <span className="text-xs text-slate-400">Case &amp; punctuation: ignored</span>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <label htmlFor="dictation-full-input" className="sr-only">
          Enter the sentence you heard
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="dictation-full-input"
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type the full sentence you hear…"
            className="w-full rounded-xl border border-indigo-300 px-4 py-2 text-base font-medium outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            aria-describedby={
              inputAriaDescribedBy
                ? `dictation-input-instruction ${inputAriaDescribedBy}`
                : "dictation-input-instruction"
            }
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={!isEnabled}
          />
          <button
            onClick={submitCurrentInput}
            disabled={!isEnabled || !inputText.trim()}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Check
          </button>
        </div>
      </div>

      {isCorrect === false && maskedResult && (
        <div
          className="rounded-xl border border-amber-200 bg-amber-50 p-3"
          role="region"
          aria-label="Answer comparison"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Answer comparison</p>
          <p className="mt-1 text-sm font-medium text-amber-900">{maskedResult}</p>
        </div>
      )}

      {wrongAttempts >= 2 && isCorrect !== true && (
        <p className="text-slate-500 text-xs">
          Having trouble? Try using a hint or ask the AI tutor for help.
        </p>
      )}
    </div>
  );
}
