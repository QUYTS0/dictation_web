"use client";

import { useCallback, useEffect, useState } from "react";
import { blobToWav16kMono } from "@/lib/utils/wavEncode";

export interface PracticeEvaluationWord {
  word: string;
  accuracyScore: number | null;
  errorType: string;
}

export interface PracticeEvaluationResult {
  accuracy: number | null;
  fluency: number | null;
  completeness: number | null;
  prosody: number | null;
  words: PracticeEvaluationWord[];
  recognizedText: string;
}

export interface PracticeQuotaState {
  /** False until the first successful quota fetch resolves, and while Azure
   *  itself isn't configured server-side — the True Evaluation section stays
   *  hidden in either case rather than showing a nonfunctional button. */
  engineConfigured: boolean;
  usedSec: number;
  limitSec: number;
  usedCount: number;
  limitReached: boolean;
}

const IDLE_QUOTA: PracticeQuotaState = {
  engineConfigured: false,
  usedSec: 0,
  limitSec: 0,
  usedCount: 0,
  limitReached: false,
};

/**
 * Drives the "True Evaluation" (Azure Pronunciation Assessment) action in
 * EvaluationTab: fetches the shared monthly quota on mount, converts the
 * recorded clip to WAV client-side, uploads it to /api/practice/evaluate,
 * and tracks loading/result/error state. See "Shadowing and Pronunciation
 * Practice Plan.md" §8 (Phase 6).
 */
export function usePracticeEvaluation() {
  const [quota, setQuota] = useState<PracticeQuotaState>(IDLE_QUOTA);
  const [status, setStatus] = useState<"idle" | "converting" | "uploading" | "done" | "error">("idle");
  const [result, setResult] = useState<PracticeEvaluationResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Not declared `async` — a promise chain instead of await, with a
  // cancellation flag returned as the effect's cleanup, mirrors the working
  // fetch-on-mount pattern already used by useBookmarks.ts. Calling an async
  // function directly in an effect body trips
  // react-hooks/set-state-in-effect even when every setState is safely past
  // an await.
  const refreshQuota = useCallback(() => {
    let isCancelled = false;
    fetch("/api/practice/quota")
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as PracticeQuotaState;
        if (isCancelled) return;
        setQuota(data);
      })
      .catch(() => {
        // Quota display is a nicety — a failed fetch just leaves the last known state.
      });
    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    return refreshQuota();
  }, [refreshQuota]);

  const reset = useCallback(() => {
    setStatus("idle");
    setResult(null);
    setErrorMessage(null);
  }, []);

  const evaluate = useCallback(
    async (params: { audioBlob: Blob; referenceText: string; durationSec: number }) => {
      setStatus("converting");
      setErrorMessage(null);
      setResult(null);
      try {
        const wav = await blobToWav16kMono(params.audioBlob);
        setStatus("uploading");

        const formData = new FormData();
        formData.set("audio", wav, "recording.wav");
        formData.set("referenceText", params.referenceText);
        formData.set("durationSec", String(params.durationSec));

        const res = await fetch("/api/practice/evaluate", { method: "POST", body: formData });
        const data = await res.json();

        if (!res.ok) {
          if (data?.error === "quota-exceeded") {
            setQuota((prev) => ({ ...prev, limitReached: true }));
          } else {
            setErrorMessage(typeof data?.error === "string" ? data.error : "Evaluation failed. Please try again.");
          }
          setStatus("error");
          return null;
        }

        const evaluated = data as PracticeEvaluationResult;
        setResult(evaluated);
        setStatus("done");
        void refreshQuota();
        return evaluated;
      } catch {
        setErrorMessage("Evaluation failed. Please try again.");
        setStatus("error");
        return null;
      }
    },
    [refreshQuota]
  );

  return { quota, status, result, errorMessage, evaluate, reset };
}
