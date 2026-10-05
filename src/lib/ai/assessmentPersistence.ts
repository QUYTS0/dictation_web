/**
 * Learning Reports P5 — typed wrappers for the overview generation RPCs of
 * migration 044 (service role only). SERVER-ONLY.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type AssessmentBeginResult =
  | { status: "started"; generation: number; token: string }
  | { status: "reuse"; generation: number }
  | { status: "in_progress"; generation: number }
  | { status: "busy" }
  | { status: "outdated_app" }
  | { status: "not_found" | "invalid_request" }
  | { status: "error"; message: string };

export async function beginAssessment(
  service: SupabaseClient,
  a: { userId: string; roundId: string; fingerprint: string; promptVersion: number; model: string }
): Promise<AssessmentBeginResult> {
  const { data, error } = await service.rpc("fn_assessment_begin", {
    p_user_id: a.userId,
    p_round_id: a.roundId,
    p_fingerprint: a.fingerprint,
    p_prompt_version: a.promptVersion,
    p_model: a.model,
  });
  if (error || !data || typeof data !== "object") return { status: "error", message: error?.message ?? "no result" };
  const d = data as Record<string, unknown>;
  switch (d.status) {
    case "started":
      return { status: "started", generation: Number(d.generation), token: String(d.token) };
    case "reuse":
    case "in_progress":
      return { status: d.status, generation: Number(d.generation) };
    case "busy":
    case "outdated_app":
    case "not_found":
    case "invalid_request":
      return { status: d.status } as AssessmentBeginResult;
    default:
      return { status: "error", message: `unexpected status ${String(d.status)}` };
  }
}

export type AssessmentFinishStatus =
  | "accepted"
  | "already_accepted"
  | "conflict"
  | "superseded"
  | "invalid_token"
  | "invalid_state"
  | "invalid_identity"
  | "invalid_payload"
  | "outdated_app"
  | "not_found";

export type AssessmentFinishResult = { status: AssessmentFinishStatus } | { status: "error"; message: string };

const FINISH: ReadonlySet<string> = new Set([
  "accepted",
  "already_accepted",
  "conflict",
  "superseded",
  "invalid_token",
  "invalid_state",
  "invalid_identity",
  "invalid_payload",
  "outdated_app",
  "not_found",
]);

export async function finishAssessment(
  service: SupabaseClient,
  a: {
    userId: string;
    roundId: string;
    generation: number;
    token: string;
    fingerprint: string;
    promptVersion: number;
    model: string;
    payload: unknown;
    meta: unknown;
  }
): Promise<AssessmentFinishResult> {
  const { data, error } = await service.rpc("fn_assessment_finish", {
    p_user_id: a.userId,
    p_round_id: a.roundId,
    p_generation: a.generation,
    p_token: a.token,
    p_fingerprint: a.fingerprint,
    p_prompt_version: a.promptVersion,
    p_model: a.model,
    p_payload: a.payload,
    p_meta: a.meta,
  });
  if (error || !data || typeof data !== "object") return { status: "error", message: error?.message ?? "no result" };
  const status = String((data as Record<string, unknown>).status);
  return FINISH.has(status) ? { status: status as AssessmentFinishStatus } : { status: "error", message: `unexpected status ${status}` };
}

/** Best-effort; never throws. Only the request that began a generation abandons it. */
export async function abandonAssessment(
  service: SupabaseClient,
  a: { userId: string; roundId: string; generation: number; token: string; reason: string }
): Promise<void> {
  try {
    const { error } = await service.rpc("fn_assessment_abandon", {
      p_user_id: a.userId,
      p_round_id: a.roundId,
      p_generation: a.generation,
      p_token: a.token,
      p_reason: a.reason,
    });
    if (error) console.error("[assessment] abandon failed:", error.message);
  } catch (err) {
    console.error("[assessment] abandon threw:", err instanceof Error ? err.message : err);
  }
}
