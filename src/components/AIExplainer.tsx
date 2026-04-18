"use client";

import { useState } from "react";
import { clsx } from "clsx";
import type { AIExplainResponse } from "@/lib/types";

interface AIExplainerProps {
  expectedText: string;
  userText: string;
  attemptId?: string;
  /** Pre-loaded explanation (e.g., from cache) */
  explanation?: AIExplainResponse | null;
  buttonLabel?: string;
}

export default function AIExplainer({
  expectedText,
  userText,
  attemptId,
  explanation: initialExplanation = null,
  buttonLabel = "Explain my mistake",
}: AIExplainerProps) {
  const [explanation, setExplanation] = useState<AIExplainResponse | null>(
    initialExplanation
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExplain = async () => {
    if (explanation || loading) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/ai/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedText, userText, attemptId }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "AI request failed.");
      }

      const data: AIExplainResponse = await res.json();
      setExplanation(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to get AI explanation."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-violet-300 bg-violet-50 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-violet-700 font-semibold text-sm">🤖 AI Tutor</span>
        {!explanation && (
          <button
            onClick={handleExplain}
            disabled={loading}
            className={clsx(
              "text-xs px-3 py-1 rounded-full font-medium transition-colors",
              loading
                ? "bg-violet-200 text-violet-400 cursor-wait"
                : "bg-violet-200 text-violet-800 hover:bg-violet-300"
            )}
          >
            {loading ? "Thinking…" : buttonLabel}
          </button>
        )}
      </div>

      {error && (
        <p className="text-red-600 text-sm">⚠ {error}</p>
      )}

      {explanation && (
        <div className="flex flex-col gap-2 text-sm text-violet-900">
          <p className="font-medium">{explanation.explanation}</p>

          <div className="rounded-lg bg-white border border-violet-200 p-3 flex flex-col gap-1">
            <p className="text-xs text-violet-500 font-semibold uppercase tracking-wide">
              Correct version
            </p>
            <p className="font-mono text-emerald-700 font-semibold">
              {explanation.correctedText}
            </p>
          </div>

          {explanation.example && (
            <div className="rounded-lg bg-white border border-violet-200 p-3 flex flex-col gap-1">
              <p className="text-xs text-violet-500 font-semibold uppercase tracking-wide">
                Example
              </p>
              <p className="font-mono text-blue-700">{explanation.example}</p>
            </div>
          )}

          {explanation.tip && (
            <p className="text-xs text-violet-600 italic">💡 {explanation.tip}</p>
          )}
        </div>
      )}
    </div>
  );
}
