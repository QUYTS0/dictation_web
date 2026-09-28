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
  /** Phase 4: the attempt and request sequence this result belongs to. */
  attemptId: string;
  seq: number;
  /** Stored on the server. When false the score is still a real evaluation
   *  of this recording — shown as "not saved". */
  persisted: boolean;
  /** A newer evaluation request for the same recording replaced this one. */
  superseded: boolean;
  /** A different result is already stored for this request (kept); this one was not saved. */
  conflict: boolean;
  /** Opaque server-signed token to retry saving (memory only, never stored). */
  recoveryToken?: string;
}

export type TrueEvaluationOutcome =
  | { ok: true; data: TrueEvaluationSuccess }
  | { ok: false; status: "failed" | "unavailable"; error: string; code?: string }
  /** Phase 4: nothing new was started — the recording's evaluation is either
   *  still running (another tab/request) or already saved. The caller reads
   *  the stored result (GET /api/practice/attempt/[id]); it must NOT post
   *  Evaluate again. */
  | { ok: false; status: "server_result"; code: "evaluation_in_progress" | "azure_already_evaluated"; attemptId: string; error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapErrorResponse(res: Response, data: any): TrueEvaluationOutcome {
  if (data?.code === "stale_client_version") {
    return { ok: false, status: "failed", code: data.code, error: "This page is out of date. Reload it to keep evaluating." };
  }
  if (data?.code === "evaluation_in_progress" || data?.code === "azure_already_evaluated") {
    return {
      ok: false,
      status: "server_result",
      code: data.code,
      attemptId: data.attemptId,
      error: data.code === "evaluation_in_progress" ? "This recording is already being evaluated." : "This recording was already evaluated.",
    };
  }
  if (data?.code === "quota_unavailable") {
    return { ok: false, status: "failed", code: data.code, error: "Pronunciation scoring is temporarily unavailable. Please try again shortly." };
  }
  if (res.status === 401) {
    return { ok: false, status: "failed", code: "authentication_required", error: "Sign in to get a pronunciation score." };
  }
  if (res.status === 409 && typeof data?.error === "string") {
    return { ok: false, status: "failed", code: data.code, error: data.error };
  }
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
      params: { audioBlob: Blob; attemptId: string }
    ): Promise<TrueEvaluationOutcome> => {
      setBusySegmentIndex(segmentIndex);
      try {
        const wav = await blobToWav16kMono(params.audioBlob);

        // Phase 4: only the saved attempt's id and the audio — the server
        // resolves the sentence text itself.
        const formData = new FormData();
        formData.set("attemptId", params.attemptId);
        formData.set("audio", wav, "recording.wav");

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
            attemptId: data.attemptId ?? params.attemptId,
            seq: data.seq,
            persisted: data.persisted === true,
            superseded: data.superseded === true,
            conflict: data.conflict === true,
            recoveryToken: typeof data.recoveryToken === "string" ? data.recoveryToken : undefined,
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
