"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { clsx } from "clsx";
import {
  BadgeCheck,
  MessageCircle,
  PenLine,
  RefreshCcw,
  Smile,
  type LucideIcon,
} from "lucide-react";
import type { DiffToken } from "@/lib/types";

interface DictationInputProps {
  isEnabled: boolean;
  isChecking?: boolean;
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

type AnswerResultStatusKey =
  | "perfect"
  | "very_close"
  | "almost_right"
  | "partly_correct"
  | "try_again";

type MatchingRules = {
  exactNormalizedMatch?: boolean;
  minSimilarity?: number;
  maxSimilarity?: number;
  maxMinorTokenIssues?: number;
  maxMajorTokenIssues?: number;
};

type StatusConfig = {
  key: AnswerResultStatusKey;
  priority: number;
  label: string;
  shortLabel: string;
  helperText: string;
  tone: "success" | "encouraging" | "coach";
  icon: "BadgeCheck" | "Smile" | "MessageCircle" | "PenLine" | "RefreshCcw";
  iconStyle: string;
  colorTokens: {
    bg: string;
    border: string;
    text: string;
    subtext: string;
    icon: string;
  };
  matchingRules: MatchingRules;
};

export const ANSWER_RESULT_STATUS_CONFIG: Record<AnswerResultStatusKey, StatusConfig> = {
  perfect: {
    key: "perfect",
    priority: 5,
    label: "Perfect",
    shortLabel: "Perfect",
    helperText: "Excellent. Your sentence matches the answer.",
    tone: "success",
    icon: "BadgeCheck",
    iconStyle: "friendly-success",
    colorTokens: {
      bg: "bg-green-50",
      border: "border-green-200",
      text: "text-green-800",
      subtext: "text-green-700",
      icon: "text-green-600",
    },
    matchingRules: {
      exactNormalizedMatch: true,
      minSimilarity: 1,
      maxMinorTokenIssues: 0,
      maxMajorTokenIssues: 0,
    },
  },
  very_close: {
    key: "very_close",
    priority: 4,
    label: "Very close",
    shortLabel: "Very close",
    helperText: "You’re very close. Fix the small highlighted part and check again.",
    tone: "encouraging",
    icon: "Smile",
    iconStyle: "friendly-near-success",
    colorTokens: {
      bg: "bg-lime-50",
      border: "border-lime-200",
      text: "text-lime-800",
      subtext: "text-lime-700",
      icon: "text-lime-600",
    },
    matchingRules: {
      exactNormalizedMatch: false,
      minSimilarity: 0.9,
      maxSimilarity: 0.9999,
      maxMinorTokenIssues: 1,
      maxMajorTokenIssues: 0,
    },
  },
  almost_right: {
    key: "almost_right",
    priority: 3,
    label: "That’s almost right",
    shortLabel: "Almost right",
    helperText: "Nice progress. You only need a little correction.",
    tone: "encouraging",
    icon: "MessageCircle",
    iconStyle: "friendly-coach",
    colorTokens: {
      bg: "bg-amber-50",
      border: "border-amber-200",
      text: "text-amber-800",
      subtext: "text-amber-700",
      icon: "text-amber-600",
    },
    matchingRules: {
      minSimilarity: 0.75,
      maxSimilarity: 0.8999,
      maxMinorTokenIssues: 2,
      maxMajorTokenIssues: 1,
    },
  },
  partly_correct: {
    key: "partly_correct",
    priority: 2,
    label: "Partly correct",
    shortLabel: "Partly correct",
    helperText: "You’re on the right track. Listen again and adjust more words.",
    tone: "coach",
    icon: "PenLine",
    iconStyle: "friendly-coach",
    colorTokens: {
      bg: "bg-sky-50",
      border: "border-sky-200",
      text: "text-sky-800",
      subtext: "text-sky-700",
      icon: "text-sky-600",
    },
    matchingRules: {
      minSimilarity: 0.45,
      maxSimilarity: 0.7499,
    },
  },
  try_again: {
    key: "try_again",
    priority: 1,
    label: "Try again",
    shortLabel: "Try again",
    helperText: "No worries. Replay and try one more time—you can do it.",
    tone: "coach",
    icon: "RefreshCcw",
    iconStyle: "friendly-retry",
    colorTokens: {
      bg: "bg-rose-50",
      border: "border-rose-200",
      text: "text-rose-800",
      subtext: "text-rose-700",
      icon: "text-rose-600",
    },
    matchingRules: {},
  },
};

export const ANSWER_RESULT_EVALUATION_CONFIG = {
  statusOrder: ["perfect", "very_close", "almost_right", "partly_correct", "try_again"] as const,
  minorTokenStatuses: ["wrong"] as const,
  majorTokenStatuses: ["missing", "extra"] as const,
} as const;

const STATUS_ICON_COMPONENTS: Record<StatusConfig["icon"], LucideIcon> = {
  BadgeCheck,
  Smile,
  MessageCircle,
  PenLine,
  RefreshCcw,
};

function buildMaskedResult(diff: DiffToken[] | undefined) {
  if (!diff || diff.length === 0) return "";
  return diff
    .filter((token) => token.status !== "extra")
    .map((token) => (token.status === "correct" ? token.word : MASKED_WORD_PLACEHOLDER))
    .join(" ");
}

function evaluateAnswerStatus(
  diff: DiffToken[] | undefined,
  isCorrect?: boolean | null
): StatusConfig | null {
  if (!diff || diff.length === 0) {
    return isCorrect ? ANSWER_RESULT_STATUS_CONFIG.perfect : null;
  }

  const totalComparable = diff.filter((token) => token.status !== "extra").length;
  if (totalComparable === 0) return null;

  const countByStatus = {
    correct: diff.filter((token) => token.status === "correct").length,
    wrong: diff.filter((token) => token.status === "wrong").length,
    missing: diff.filter((token) => token.status === "missing").length,
    extra: diff.filter((token) => token.status === "extra").length,
  };

  const minorTokenIssues = ANSWER_RESULT_EVALUATION_CONFIG.minorTokenStatuses.reduce(
    (sum, status) => sum + countByStatus[status],
    0
  );
  const majorTokenIssues = ANSWER_RESULT_EVALUATION_CONFIG.majorTokenStatuses.reduce(
    (sum, status) => sum + countByStatus[status],
    0
  );
  const similarity = countByStatus.correct / totalComparable;
  const exactNormalizedMatch =
    isCorrect === true ||
    (countByStatus.wrong === 0 && countByStatus.missing === 0 && countByStatus.extra === 0);

  const matchesRules = (rules: MatchingRules) => {
    if (
      rules.exactNormalizedMatch !== undefined &&
      exactNormalizedMatch !== rules.exactNormalizedMatch
    ) {
      return false;
    }
    if (rules.minSimilarity !== undefined && similarity < rules.minSimilarity) return false;
    if (rules.maxSimilarity !== undefined && similarity > rules.maxSimilarity) return false;
    if (rules.maxMinorTokenIssues !== undefined && minorTokenIssues > rules.maxMinorTokenIssues) {
      return false;
    }
    if (rules.maxMajorTokenIssues !== undefined && majorTokenIssues > rules.maxMajorTokenIssues) {
      return false;
    }
    return true;
  };

  for (const statusKey of ANSWER_RESULT_EVALUATION_CONFIG.statusOrder) {
    const statusConfig = ANSWER_RESULT_STATUS_CONFIG[statusKey];
    if (statusKey === "try_again") return statusConfig;
    if (matchesRules(statusConfig.matchingRules)) return statusConfig;
  }

  return ANSWER_RESULT_STATUS_CONFIG.try_again;
}

function summarizeDiff(diff: DiffToken[] | undefined) {
  if (!diff || diff.length === 0) {
    return { wrong: 0, missing: 0, extra: 0, extraWords: [] as string[] };
  }
  return {
    wrong: diff.filter((token) => token.status === "wrong").length,
    missing: diff.filter((token) => token.status === "missing").length,
    extra: diff.filter((token) => token.status === "extra").length,
    extraWords: diff.filter((token) => token.status === "extra").map((token) => token.word),
  };
}

const INITIAL_FOCUS_DELAY_MS = 50;
const FOCUS_DELAY_MS = 10;

export default function DictationInput({
  isEnabled,
  isChecking = false,
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
  const resultState = useMemo(() => evaluateAnswerStatus(diff, isCorrect), [diff, isCorrect]);
  const diffSummary = useMemo(() => summarizeDiff(diff), [diff]);

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

  const isEmpty = !inputText.trim();
  const isButtonDisabled = !isEnabled || isEmpty || isChecking;
  const hasResult = !isChecking && (isCorrect === true || isCorrect === false);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
    
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
            disabled={!isEnabled || isChecking}
          />
          <button
            onClick={submitCurrentInput}
            disabled={isButtonDisabled}
            aria-busy={isChecking}
            className={clsx(
              "rounded-xl px-5 py-2.5 text-sm font-semibold shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1",
              isChecking
                ? "bg-indigo-500 text-white focus:ring-indigo-300"
                : hasResult
                ? "bg-emerald-600 text-white focus:ring-emerald-300"
                : isEmpty
                ? "bg-slate-300 text-slate-600"
                : "bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-md focus:ring-indigo-300",
              isButtonDisabled && "cursor-not-allowed"
            )}
          >
            {isChecking ? "Checking..." : hasResult ? "Checked" : "Check"}
          </button>
        </div>
      </div>

      {resultState && (
        <div
          className={clsx(
            "rounded-xl border p-3",
            resultState.colorTokens.bg,
            resultState.colorTokens.border
          )}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-2">
            {(() => {
              const ResultIcon = STATUS_ICON_COMPONENTS[resultState.icon];
              return <ResultIcon className={clsx("mt-0.5 h-4 w-4 shrink-0", resultState.colorTokens.icon)} />;
            })()}
            <div>
              <p className={clsx("text-xs font-semibold uppercase tracking-wide", resultState.colorTokens.text)}>
                {resultState.label}
              </p>
              <p className={clsx("mt-0.5 text-xs", resultState.colorTokens.subtext)}>
                {resultState.helperText}
              </p>
            </div>
          </div>
        </div>
      )}

      {isCorrect === false && maskedResult && (
        <div
          className="rounded-xl border border-amber-200 bg-amber-50 p-3"
          role="region"
          aria-label="Answer comparison"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Answer comparison</p>
          <p className="mt-1 text-sm font-medium text-amber-900">{maskedResult}</p>
          {(diffSummary.missing > 0 || diffSummary.wrong > 0 || diffSummary.extra > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {diffSummary.missing > 0 && (
                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                  Missing {diffSummary.missing}
                </span>
              )}
              {diffSummary.wrong > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  Wrong {diffSummary.wrong}
                </span>
              )}
              {diffSummary.extra > 0 && (
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                  Extra {diffSummary.extra}
                </span>
              )}
            </div>
          )}
          {diffSummary.extraWords.length > 0 && (
            <div className="mt-2">
              <p className="text-[11px] font-medium text-violet-700">Extra words in your answer:</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {diffSummary.extraWords.map((word, index) => (
                  <span
                    key={`${word}-${index}`}
                    className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700"
                  >
                    {word}
                  </span>
                ))}
              </div>
            </div>
          )}
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
