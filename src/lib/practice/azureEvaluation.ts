import type { SupabaseClient } from "@supabase/supabase-js";
import type { AzurePronunciationResult, AzurePronunciationWord } from "@/lib/azureSpeech";
import type { RecoveryResult } from "./recoveryToken";

/** Stays well under fn_finish_azure_evaluation's 128 KB detail limit. */
const MAX_DETAIL_BYTES = 96 * 1024;

export const AZURE_ENGINE_VERSION = "azure-short-audio-pa/v1";

function detailSize(detail: unknown): number {
  return Buffer.byteLength(JSON.stringify(detail));
}

/**
 * What of an Azure result is stored with the attempt: the headline scores
 * (null stays null — a metric Azure didn't return is unavailable, never 0)
 * and per-word detail for restoring the display after a reload. The raw
 * provider payload is never stored. Oversized detail is thinned (alternates
 * first, then sub-word detail) rather than rejected.
 */
export function toStoredAzureResult(result: AzurePronunciationResult): RecoveryResult | null {
  if (typeof result.pronScore !== "number") return null;
  let words: AzurePronunciationWord[] = result.words ?? [];
  let detail: Record<string, unknown> = { recognizedText: result.recognizedText ?? "", words };
  if (detailSize(detail) > MAX_DETAIL_BYTES) {
    words = words.map((w) => ({ ...w, phonemes: w.phonemes?.map((p) => ({ ...p, nBestPhonemes: undefined })) }));
    detail = { recognizedText: result.recognizedText ?? "", words };
  }
  if (detailSize(detail) > MAX_DETAIL_BYTES) {
    words = words.map((w) => ({ word: w.word, accuracyScore: w.accuracyScore, errorType: w.errorType }));
    detail = { recognizedText: result.recognizedText ?? "", words };
  }
  return {
    pronunciationScore: result.pronScore,
    accuracyScore: result.accuracy ?? null,
    fluencyScore: result.fluency ?? null,
    completenessScore: result.completeness ?? null,
    prosodyScore: result.prosody ?? null,
    detail: detailSize(detail) > MAX_DETAIL_BYTES ? null : detail,
    engineVersion: AZURE_ENGINE_VERSION,
  };
}

export type FinishOutcome = "applied" | "already_applied" | "superseded" | "conflict";

export interface FinishResult {
  applied: boolean;
  outcome: FinishOutcome;
  currentSeq: number;
  status: string;
}

export type RpcError = { message?: string; code?: string } | null;

/** One call to fn_finish_azure_evaluation for a completed result. */
export async function finishAzureCompleted(
  service: Pick<SupabaseClient, "rpc">,
  claims: { attemptId: string; userId: string; seq: number },
  result: RecoveryResult
): Promise<{ data: FinishResult | null; error: RpcError }> {
  const { data, error } = await service.rpc("fn_finish_azure_evaluation", {
    p_attempt_id: claims.attemptId,
    p_user_id: claims.userId,
    p_seq: claims.seq,
    p_status: "completed",
    p_pronunciation_score: result.pronunciationScore,
    p_accuracy_score: result.accuracyScore,
    p_fluency_score: result.fluencyScore,
    p_completeness_score: result.completenessScore,
    p_prosody_score: result.prosodyScore,
    p_detail: result.detail,
    p_error_reason: null,
    p_engine_version: result.engineVersion,
  });
  return { data: (data as FinishResult | null) ?? null, error: (error as RpcError) ?? null };
}

/** Records a failed evaluation for this seq. Best effort: a failure here
 *  leaves the attempt pending, which the timeout later reports as expired. */
export async function finishAzureFailed(
  service: Pick<SupabaseClient, "rpc">,
  claims: { attemptId: string; userId: string; seq: number },
  reason: string
): Promise<FinishResult | null> {
  const { data, error } = await service.rpc("fn_finish_azure_evaluation", {
    p_attempt_id: claims.attemptId,
    p_user_id: claims.userId,
    p_seq: claims.seq,
    p_status: "failed",
    p_error_reason: reason,
  });
  if (error) {
    console.error("[practice/evaluate] could not record the failed evaluation:", error);
    return null;
  }
  return data as FinishResult;
}

export const PERSIST_RETRY_DELAYS_MS = [0, 250, 750];

/**
 * Bounded retry of the result write (plan §9.4: 3 tries, short backoff).
 * Only a transport/database ERROR is retried; a definitive outcome (applied,
 * already applied, superseded, conflict) or a definitive refusal is returned
 * as is.
 */
export type PersistOutcome =
  | { kind: "result"; result: FinishResult }
  | { kind: "rejected"; reason: string }
  | { kind: "unavailable" };

export async function persistWithRetry(
  service: Pick<SupabaseClient, "rpc">,
  claims: { attemptId: string; userId: string; seq: number },
  result: RecoveryResult,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<PersistOutcome> {
  for (const delay of PERSIST_RETRY_DELAYS_MS) {
    if (delay) await sleep(delay);
    try {
      const { data, error } = await finishAzureCompleted(service, claims, result);
      if (!error && data) return { kind: "result", result: data };
      if (error?.message === "attempt_not_found" || error?.message === "invalid_payload") {
        console.error("[practice/evaluate] result rejected by the database:", error.message);
        return { kind: "rejected", reason: error.message };
      }
      console.warn("[practice/evaluate] persisting the result failed, retrying:", error?.code ?? error?.message);
    } catch (err) {
      console.warn("[practice/evaluate] persisting the result threw, retrying:", (err as Error)?.message);
    }
  }
  return { kind: "unavailable" };
}
