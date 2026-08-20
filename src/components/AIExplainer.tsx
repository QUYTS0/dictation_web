"use client";

import { useCallback, useEffect, useState } from "react";
import { clsx } from "clsx";
import type { AIExplainResponse } from "@/lib/types";

interface GeminiQuotaStatus {
  configured: boolean;
  rpdUsed: number;
  rpdLimit: number;
}

interface AIExplainerProps {
  expectedText: string;
  userText: string;
  attemptId?: string;
  /** Pre-loaded explanation (e.g., from cache) */
  explanation?: AIExplainResponse | null;
  buttonLabel?: string;
  onExplanationReady?: (ready: boolean) => void;
}

export default function AIExplainer({
  expectedText,
  userText,
  attemptId,
  explanation: initialExplanation = null,
  buttonLabel = "Explain my mistake",
  onExplanationReady,
}: AIExplainerProps) {
  const [explanation, setExplanation] = useState<AIExplainResponse | null>(
    initialExplanation
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<GeminiQuotaStatus | null>(null);

  useEffect(() => {
    onExplanationReady?.(Boolean(explanation));
  }, [explanation, onExplanationReady]);

  // Shared daily budget with /api/transcript/translate — checked so the
  // button can be disabled proactively instead of letting the user spend a
  // click on a request that's just going to 429.
  const refreshQuota = useCallback(() => {
    void fetch("/api/ai/quota")
      .then((res) => (res.ok ? (res.json() as Promise<GeminiQuotaStatus>) : null))
      .then((data) => setQuota(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!explanation) refreshQuota();
  }, [explanation, refreshQuota]);

  const quotaExhausted = Boolean(quota?.configured && quota.rpdUsed >= quota.rpdLimit);

  const handleExplain = async () => {
    if (explanation || loading || quotaExhausted) return;
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
      refreshQuota();
    }
  };

  return (
    <div className="rounded-xl border border-violet-300 bg-violet-50 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-violet-700 font-semibold text-sm">
          <span aria-hidden="true">🤖 </span>AI Tutor
        </span>
        {!explanation && (
          <button
            onClick={handleExplain}
            disabled={loading || quotaExhausted}
            title={quotaExhausted ? "Daily AI quota reached — try again tomorrow" : undefined}
            className={clsx(
              "text-xs px-3 py-1 rounded-full font-medium transition-colors",
              loading
                ? "bg-violet-200 text-violet-400 cursor-wait"
                : quotaExhausted
                  ? "bg-violet-100 text-violet-300 cursor-not-allowed"
                  : "bg-violet-200 text-violet-800 hover:bg-violet-300"
            )}
          >
            {loading ? "Thinking…" : quotaExhausted ? "Quota reached" : buttonLabel}
          </button>
        )}
      </div>

      {!explanation && quota?.configured && (
        <p className="text-[11px] text-violet-500">
          {quotaExhausted
            ? "Daily AI quota reached — try again tomorrow."
            : `${Math.max(quota.rpdLimit - quota.rpdUsed, 0)}/${quota.rpdLimit} AI calls left today`}
        </p>
      )}

      {error && (
        <p role="alert" className="text-red-600 text-sm flex items-center gap-2">
          <span>
            <span aria-hidden="true">⚠ </span>
            {error}
          </span>
          <button
            onClick={handleExplain}
            disabled={loading}
            className="text-xs font-semibold underline text-red-700 hover:text-red-900 disabled:opacity-50"
          >
            Retry
          </button>
        </p>
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
