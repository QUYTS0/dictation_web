"use client";

import { useCallback, useEffect, useState } from "react";
import { blobToWav16kMono } from "@/lib/utils/wavEncode";
import type { AzureRawPronunciationResult, TrueEvaluationWord } from "./types";

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

export interface TrueEvaluationSuccess {
  // Matches TrueEvaluationResult's own optional-field convention (undefined
  // = Azure didn't return this metric) rather than Azure's raw `null`.
  pronunciationScore: number | undefined;
  accuracyScore: number | undefined;
  fluencyScore: number | undefined;
  completenessScore: number | undefined;
  prosodyScore: number | undefined;
  words: TrueEvaluationWord[];
  recognizedText: string;
  rawAzureResult: AzureRawPronunciationResult | undefined;
}

export type TrueEvaluationOutcome =
  | { ok: true; data: TrueEvaluationSuccess }
  | { ok: false; status: "failed" | "unavailable"; error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapErrorResponse(res: Response, data: any): TrueEvaluationOutcome {
  if (data?.error === "quota-exceeded" || res.status === 429) {
    return {
      ok: false,
      status: "failed",
      error: typeof data?.message === "string" ? data.message : "You've used this month's free evaluations.",
    };
  }
  if (res.status === 503) {
    return { ok: false, status: "unavailable", error: "Pronunciation scoring isn't set up for this site yet." };
  }
  const message = typeof data?.error === "string" ? data.error : "";
  if (message.toLowerCase().includes("timed out")) {
    return { ok: false, status: "failed", error: "The evaluation request timed out. Please try again." };
  }
  if (res.status === 400 || res.status === 413) {
    return { ok: false, status: "failed", error: "That recording couldn't be evaluated — try recording again." };
  }
  // Azure/server errors (502, and anything else unmapped above) already
  // carry a specific, user-facing reason from AzureSpeechError (e.g. "No
  // speech was recognized...", "Pronunciation scoring wasn't returned...") —
  // show it rather than replacing it with a generic message that would hide
  // the actual cause.
  if (message) {
    return { ok: false, status: "failed", error: message };
  }
  return { ok: false, status: "failed", error: "Something went wrong while scoring your recording. Please try again." };
}

/**
 * Drives the "True Evaluation" (Azure Pronunciation Assessment) network call:
 * fetches the shared monthly quota on mount, converts a recorded clip to WAV
 * client-side, uploads it to /api/practice/evaluate, and maps the response
 * (or failure) to a plain outcome. Deliberately holds no per-sentence result
 * state itself — the caller (page.tsx) owns exactly one instance of this
 * hook and writes outcomes into the shared, sessionStorage-backed
 * useShadowingEvaluations map, so an in-flight request's result always has
 * somewhere stable to land even if the Evaluation tab isn't mounted when it
 * resolves. See "Shadowing and Pronunciation Practice Plan.md" §8 (Phase 6).
 */
export function usePracticeEvaluation() {
  const [quota, setQuota] = useState<PracticeQuotaState>(IDLE_QUOTA);
  // Only one True Evaluation request in flight at a time — the segment it's
  // scoring, or null. Used to disable duplicate Evaluate clicks.
  const [busySegmentIndex, setBusySegmentIndex] = useState<number | null>(null);

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

  const evaluate = useCallback(
    async (
      segmentIndex: number,
      params: { audioBlob: Blob; referenceText: string; durationSec: number }
    ): Promise<TrueEvaluationOutcome> => {
      setBusySegmentIndex(segmentIndex);
      try {
        const wav = await blobToWav16kMono(params.audioBlob);

        const formData = new FormData();
        formData.set("audio", wav, "recording.wav");
        formData.set("referenceText", params.referenceText);
        formData.set("durationSec", String(params.durationSec));

        const res = await fetch("/api/practice/evaluate", { method: "POST", body: formData });
        const data = await res.json();

        if (!res.ok) {
          const outcome = mapErrorResponse(res, data);
          if (data?.error === "quota-exceeded") {
            setQuota((prev) => ({ ...prev, limitReached: true }));
          }
          return outcome;
        }

        void refreshQuota();
        return {
          ok: true,
          data: {
            pronunciationScore: data.pronScore ?? undefined,
            accuracyScore: data.accuracy ?? undefined,
            fluencyScore: data.fluency ?? undefined,
            completenessScore: data.completeness ?? undefined,
            prosodyScore: data.prosody ?? undefined,
            words: data.words ?? [],
            recognizedText: data.recognizedText ?? "",
            rawAzureResult: data.rawResult ?? undefined,
          },
        };
      } catch {
        return { ok: false, status: "failed", error: "Something went wrong while scoring your recording. Please try again." };
      } finally {
        setBusySegmentIndex((current) => (current === segmentIndex ? null : current));
      }
    },
    [refreshQuota]
  );

  return { quota, busySegmentIndex, evaluate };
}
