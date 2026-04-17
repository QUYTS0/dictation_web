"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { clsx } from "clsx";
import type { DiffToken } from "@/lib/types";

interface DictationInputProps {
  isEnabled: boolean;
  /** Total number of expected words — determines how many blank slots to show */
  wordCount: number;
  onSubmit: (text: string) => void;
  diff?: DiffToken[];
  isCorrect?: boolean | null;
  /** Number of wrong attempts for this segment */
  wrongAttempts?: number;
  /** Increment to request focus from keyboard shortcuts (e.g. "/") */
  focusSignal?: number;
}

/**
 * Extracts expected-position correctness from an LCS diff.
 * Returns an array of length ~wordCount where each entry is the matched
 * word string (if correct at that expected position) or null (missing/wrong).
 * "extra" tokens (user-only) are skipped — they have no expected slot.
 */
type ExpectedSlot = {
  value: string;
  isLocked: boolean;
};

function buildExpectedSlots(diff: DiffToken[]): ExpectedSlot[] {
  const result: ExpectedSlot[] = [];
  for (const token of diff) {
    if (token.status === "correct") {
      result.push({ value: token.word, isLocked: true });
    } else if (token.status === "missing" || token.status === "wrong") {
      result.push({
        value: token.status === "wrong" ? token.word : "",
        isLocked: false,
      });
    }
    // skip "extra" tokens — they are user-only tokens with no expected slot
  }
  return result;
}

const INITIAL_FOCUS_DELAY_MS = 50;
const FOCUS_DELAY_MS = 10;

export default function DictationInput({
  isEnabled,
  wordCount,
  onSubmit,
  diff,
  isCorrect,
  wrongAttempts = 0,
  focusSignal = 0,
}: DictationInputProps) {
  const [typedWords, setTypedWords] = useState<string[]>([]);
  const [currentInput, setCurrentInput] = useState("");
  const [currentWordIdx, setCurrentWordIdx] = useState(0);
  const [lockedSlots, setLockedSlots] = useState<boolean[]>([]);
  const [editableIndices, setEditableIndices] = useState<number[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const isCorrectionMode = isCorrect === false && editableIndices.length > 0;
  const editableIndexPositionMap = useMemo(() => {
    const indexMap = new Map<number, number>();
    editableIndices.forEach((slotIdx, pos) => {
      indexMap.set(slotIdx, pos);
    });
    return indexMap;
  }, [editableIndices]);

  const focusInput = useCallback(
    (delay = FOCUS_DELAY_MS) => window.setTimeout(() => inputRef.current?.focus(), delay),
    []
  );

  const getRelativeEditableIndex = (idx: number, step: -1 | 1) => {
    const pos = editableIndexPositionMap.get(idx);
    if (pos === undefined) return null;
    return editableIndices[pos + step] ?? null;
  };

  const getNextEditableIndex = (idx: number) => getRelativeEditableIndex(idx, 1);

  const getPreviousEditableIndex = (idx: number) => {
    return getRelativeEditableIndex(idx, -1);
  };

  // Reset state and focus the input on mount (component is remounted for each
  // new segment and after each wrong-answer retry via the `key` prop in page.tsx).
  useEffect(() => {
    const t = focusInput(INITIAL_FOCUS_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [focusInput]);

  useEffect(() => {
    if (!isEnabled) return;
    const t = focusInput();
    return () => window.clearTimeout(t);
  }, [focusInput, focusSignal, isEnabled]);

  useEffect(() => {
    if (diff && isCorrect === false) {
      const expectedSlots = buildExpectedSlots(diff);
      const reconstructed: string[] = [];
      const locked: boolean[] = [];
      const editable: number[] = [];
      for (let i = 0; i < wordCount; i++) {
        const slot = expectedSlots[i];
        const isLocked = slot?.isLocked ?? false;
        reconstructed.push(slot?.value ?? "");
        locked.push(isLocked);
        if (!isLocked) editable.push(i);
      }

      setTypedWords(reconstructed);
      setLockedSlots(locked);
      setEditableIndices(editable);

      if (editable.length > 0) {
        const firstWrongIdx = editable[0];
        setCurrentWordIdx(firstWrongIdx);
        setCurrentInput(reconstructed[firstWrongIdx] ?? "");
        const t = focusInput();
        return () => window.clearTimeout(t);
      }
    } else {
      setLockedSlots(Array.from({ length: wordCount }, () => false));
      setEditableIndices(Array.from({ length: wordCount }, (_, i) => i));
    }
  }, [diff, focusInput, isCorrect, wordCount]);

  /**
   * Commits `input` as the word at slot `idx`, advances the pointer,
   * and auto-submits when all slots are filled.
   */
  const commitWord = (input: string, typed: string[], idx: number) => {
    const word = input.trim();
    if (!word) return;
    if (lockedSlots[idx]) return;
    const newTyped = [...typed];
    newTyped[idx] = word;

    if (isCorrectionMode) {
      const nextEditableIdx = getNextEditableIndex(idx);
      setTypedWords(newTyped);
      if (nextEditableIdx === null) {
        setCurrentInput("");
        setCurrentWordIdx(wordCount);
        onSubmit(newTyped.join(" "));
      } else {
        setCurrentInput(newTyped[nextEditableIdx] ?? "");
        setCurrentWordIdx(nextEditableIdx);
      }
    } else {
      const newIdx = idx + 1;
      if (newIdx >= wordCount) {
        // All slots filled — auto-submit immediately
        setTypedWords(newTyped);
        setCurrentInput("");
        setCurrentWordIdx(newIdx);
        onSubmit(newTyped.join(" "));
      } else {
        setTypedWords(newTyped);
        // Pre-populate the next slot if the user had previously typed something there
        setCurrentInput(newTyped[newIdx] ?? "");
        setCurrentWordIdx(newIdx);
      }
    }
  };

  /**
   * Navigate to slot `i` for editing — sets it as the active slot and
   * restores any previously committed value as the current input.
   */
  const navigateToSlot = (i: number) => {
    if (!isEnabled) return;
    if (lockedSlots[i]) return;
    setCurrentInput(typedWords[i] ?? "");
    setCurrentWordIdx(i);
    focusInput();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Space advances to the next slot
    if ((e.key === " " || e.key === "Spacebar") && currentWordIdx < wordCount) {
      e.preventDefault();
      commitWord(currentInput, typedWords, currentWordIdx);
    // Enter on any slot: commit current word and submit (handles last word too)
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (currentWordIdx < wordCount && currentInput.trim()) {
        commitWord(currentInput, typedWords, currentWordIdx);
      } else if (typedWords.filter(Boolean).length > 0 || currentInput.trim()) {
        const finalWords = [...typedWords];
        if (currentInput.trim() && currentWordIdx < wordCount) {
          finalWords[currentWordIdx] = currentInput.trim();
        }
        onSubmit(finalWords.filter(Boolean).join(" "));
      }
    // Backspace on empty input navigates back to re-type the previous word.
    // Also clears the current slot so the deleted word does not reappear.
    } else if (e.key === "Backspace" && currentInput === "" && currentWordIdx > 0) {
      const newTyped = [...typedWords];
      if (!lockedSlots[currentWordIdx]) newTyped[currentWordIdx] = "";
      const prevIdx: number | null = isCorrectionMode
        ? getPreviousEditableIndex(currentWordIdx)
        : currentWordIdx > 0
        ? currentWordIdx - 1
        : null;
      if (prevIdx !== null && prevIdx >= 0) {
        setTypedWords(newTyped);
        setCurrentInput(newTyped[prevIdx] ?? "");
        setCurrentWordIdx(prevIdx);
        focusInput();
      }
    }
  };

  // Handle paste: split on first space so pasting a full word works naturally
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val.includes(" ")) {
      const first = val.split(" ")[0].trim();
      if (first) commitWord(first, typedWords, currentWordIdx);
    } else {
      setCurrentInput(val);
    }
  };

  // ---- Build word-slot nodes ----
  const slots: React.ReactNode[] = [];
  const currentEditablePosition =
    editableIndexPositionMap.get(currentWordIdx) ?? -1;
  for (let i = 0; i < wordCount; i++) {
    if (lockedSlots[i]) {
      slots.push(
        <span
          key={i}
          className={clsx(
            "inline-flex items-center justify-center min-w-[2.5rem] h-8 px-2 rounded font-medium text-sm border-b-2",
            "border-emerald-400 text-emerald-700 bg-emerald-50"
          )}
        >
          {typedWords[i]}
        </span>
      );
    } else if (i === currentWordIdx && isEnabled) {
      // Active slot — mirrors what the user is currently typing
      slots.push(
        <span
          key={i}
          className="inline-flex items-center justify-center min-w-[2.5rem] h-8 px-2 rounded font-medium text-sm border-b-2 border-indigo-500 text-indigo-700"
        >
          {currentInput || <span className="opacity-30 select-none">_</span>}
        </span>
      );
    } else if (typedWords[i]) {
      // Committed word (before cursor) or previously-typed word (after cursor) —
      // clicking it navigates directly to that slot for editing.
      const isBeforeCursor = i < currentWordIdx;
      slots.push(
        <span
          key={i}
          onClick={() => navigateToSlot(i)}
          title="Click to edit"
          className={clsx(
            "inline-flex items-center justify-center min-w-[2.5rem] h-8 px-2 rounded font-medium text-sm border-b-2 cursor-pointer transition-colors",
            isEnabled
              ? isCorrectionMode
                ? "border-amber-300 text-amber-700 bg-amber-50 hover:border-indigo-400 hover:bg-indigo-50"
                : isBeforeCursor
                ? "border-slate-400 text-slate-700 bg-slate-50 hover:border-indigo-400 hover:bg-indigo-50"
                : "border-amber-300 text-amber-700 bg-amber-50 hover:border-indigo-400 hover:bg-indigo-50"
              : "border-slate-400 text-slate-700 bg-slate-50"
          )}
        >
          {typedWords[i]}
        </span>
      );
    } else {
      // Empty future slot — clickable so the user can jump directly to any position
      slots.push(
        <span
          key={i}
          onClick={() => isEnabled && navigateToSlot(i)}
          title={isEnabled ? "Click to type here" : undefined}
          className={clsx(
            "inline-flex items-center justify-center min-w-[2.5rem] h-8 px-2 rounded font-medium text-sm border-b-2 border-slate-200 text-slate-300 transition-colors",
            isEnabled && "cursor-pointer hover:border-indigo-400 hover:bg-indigo-50"
          )}
        >
          _
        </span>
      );
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-slate-500 text-xs">
          {isCorrectionMode && isEnabled && currentWordIdx < wordCount
            ? `Correct word ${currentEditablePosition + 1} of ${editableIndices.length} — press Space`
            : isEnabled && currentWordIdx < wordCount
            ? `Word ${currentWordIdx + 1} of ${wordCount} — type then press Space`
            : `Fill in ${wordCount} word${wordCount !== 1 ? "s" : ""}`}
        </span>
        <span className="text-xs text-slate-400">Case &amp; punctuation: ignored</span>
      </div>

      {/* Word-slot display */}
      <div className="flex flex-wrap gap-2 p-3 rounded-xl border border-slate-200 bg-white min-h-12 items-center">
        {slots}
      </div>

      {/* Current-word input field (only shown while filling slots) */}
      {isEnabled && currentWordIdx < wordCount && (
        <input
          ref={inputRef}
          type="text"
          value={currentInput}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            isCorrectionMode
              ? `Correct word ${currentEditablePosition + 1}…`
              : `Type word ${currentWordIdx + 1}…`
          }
          className="w-full rounded-xl border border-indigo-300 px-4 py-2 text-base font-medium outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      )}

      {/* Wrong-attempts hint */}
      {wrongAttempts >= 2 && isCorrect !== true && (
        <p className="text-slate-500 text-xs">
          Having trouble? Try using a hint or ask the AI tutor for help.
        </p>
      )}
    </div>
  );
}
