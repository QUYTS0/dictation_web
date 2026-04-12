"use client";

import { useState, useRef, useEffect } from "react";
import { clsx } from "clsx";
import type { DiffToken, MatchMode } from "@/lib/types";

interface DictationInputProps {
  isEnabled: boolean;
  matchMode: MatchMode;
  onMatchModeChange: (mode: MatchMode) => void;
  onSubmit: (text: string) => void;
  diff?: DiffToken[];
  isCorrect?: boolean | null;
  errorMessage?: string | null;
  /** Number of wrong attempts for this segment */
  wrongAttempts?: number;
}

export default function DictationInput({
  isEnabled,
  matchMode,
  onMatchModeChange,
  onSubmit,
  diff,
  isCorrect,
  errorMessage,
  wrongAttempts = 0,
}: DictationInputProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus input whenever it becomes enabled
  useEffect(() => {
    if (isEnabled) {
      inputRef.current?.focus();
    }
  }, [isEnabled]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!value.trim() || !isEnabled) return;
      onSubmit(value.trim());
      setValue("");
    }
  };

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || !isEnabled) return;
    onSubmit(trimmed);
    setValue("");
  };

  const modes: MatchMode[] = ["exact", "relaxed", "learning"];

  return (
    <div className="flex flex-col gap-3">
      {/* Mode selector */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-500 font-medium">Mode:</span>
        {modes.map((m) => (
          <button
            key={m}
            onClick={() => onMatchModeChange(m)}
            className={clsx(
              "px-3 py-1 rounded-full border text-xs font-semibold transition-colors",
              matchMode === m
                ? "bg-indigo-600 text-white border-indigo-600"
                : "bg-white text-slate-600 border-slate-300 hover:border-indigo-400"
            )}
          >
            {m.charAt(0).toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>

      {/* Text area */}
      <div className="relative">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!isEnabled}
          placeholder={
            isEnabled ? "Type what you heard… (Enter to submit)" : "Waiting…"
          }
          rows={3}
          className={clsx(
            "w-full rounded-xl border px-4 py-3 text-base font-medium resize-none transition-colors outline-none",
            isEnabled
              ? "border-indigo-300 bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
              : "border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed",
            isCorrect === true && "border-emerald-400 bg-emerald-50",
            isCorrect === false && "border-red-400 bg-red-50"
          )}
        />
      </div>

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={!isEnabled || !value.trim()}
        className={clsx(
          "self-end px-6 py-2 rounded-xl font-semibold text-sm transition-colors",
          isEnabled && value.trim()
            ? "bg-indigo-600 text-white hover:bg-indigo-700"
            : "bg-slate-200 text-slate-400 cursor-not-allowed"
        )}
      >
        Check Answer
      </button>

      {/* Feedback diff */}
      {diff && diff.length > 0 && (
        <div
          className={clsx(
            "rounded-xl border p-3 text-sm font-mono flex flex-wrap gap-1",
            isCorrect ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"
          )}
        >
          {diff.map((token, i) => (
            <span
              key={i}
              className={clsx(
                "px-1 rounded",
                token.status === "correct" && "text-emerald-700",
                token.status === "wrong" && "bg-red-200 text-red-800",
                token.status === "missing" && "bg-amber-200 text-amber-800 line-through",
                token.status === "extra" && "bg-blue-200 text-blue-800"
              )}
            >
              {token.word}
            </span>
          ))}
        </div>
      )}

      {/* Error message */}
      {errorMessage && (
        <p className="text-red-600 text-sm flex items-center gap-1">
          <span>⚠</span> {errorMessage}
        </p>
      )}

      {/* Wrong attempts hint */}
      {wrongAttempts >= 2 && !isCorrect && (
        <p className="text-slate-500 text-xs">
          Having trouble? Try using a hint or ask the AI tutor for help.
        </p>
      )}
    </div>
  );
}
