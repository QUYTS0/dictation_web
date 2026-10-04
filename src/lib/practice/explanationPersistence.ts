/**
 * Learning Reports P4 — typed wrappers for the explanation writer RPCs of
 * migration 043 (service role only). SERVER-ONLY.
 *
 * Protocol for every writer route:
 *   begin  → (quota) → provider call OUTSIDE any DB transaction → finish
 *   any failure that makes completion impossible → abandon
 * Saved notes are never deleted by any of these calls.
 *
 * Limits (stated, not hidden): this is not exactly-once provider execution.
 * A lease lasts 120 s; a worker slower than that can overlap a new
 * operation for the same targets (both may be paid; the higher seq wins on
 * display). A provider call whose outcome is ambiguous (timeout) may still
 * have been charged by the provider. P4 has no recovery endpoint: provider
 * success followed by a failed finish loses that output (it is shown as
 * "not saved", never as saved). The finish RPC is already retry-safe for
 * P5's recovery (token-checked, idempotent on the canonical payload).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const MAX_EXPLANATION_TARGETS = 35;

export type ExplanationIntent = "missing" | "reexplain";
export type ExplanationKind = "batch" | "single";

export function parseExplanationIntent(value: unknown): ExplanationIntent | null {
  if (value === undefined || value === null) return "missing";
  return value === "missing" || value === "reexplain" ? value : null;
}

export type BeginResult =
  | { status: "started"; operationId: string; token: string; seq: number; targets: string[]; covered: string[] }
  | { status: "reuse"; covered: string[] }
  | { status: "in_progress"; operationId: string }
  | { status: "busy" }
  | { status: "not_found" | "invalid_targets" | "invalid_request" }
  | { status: "error"; message: string };

export async function beginExplanations(
  service: SupabaseClient,
  args: {
    userId: string;
    roundId: string;
    targetAttemptIds: string[];
    kind: ExplanationKind;
    intent: ExplanationIntent;
    promptVersion: number;
    model: string;
  }
): Promise<BeginResult> {
  const { data, error } = await service.rpc("fn_explanations_begin", {
    p_user_id: args.userId,
    p_round_id: args.roundId,
    p_target_attempt_ids: args.targetAttemptIds,
    p_kind: args.kind,
    p_intent: args.intent,
    p_prompt_version: args.promptVersion,
    p_model: args.model,
  });
  if (error || !data || typeof data !== "object") {
    return { status: "error", message: error?.message ?? "no result" };
  }
  const d = data as Record<string, unknown>;
  switch (d.status) {
    case "started":
      return {
        status: "started",
        operationId: String(d.operationId),
        token: String(d.token),
        seq: Number(d.seq),
        targets: (d.targets as string[]) ?? [],
        covered: (d.covered as string[]) ?? [],
      };
    case "reuse":
      return { status: "reuse", covered: (d.covered as string[]) ?? [] };
    case "in_progress":
      return { status: "in_progress", operationId: String(d.operationId) };
    case "busy":
    case "not_found":
    case "invalid_targets":
    case "invalid_request":
      return { status: d.status } as BeginResult;
    default:
      return { status: "error", message: `unexpected status ${String(d.status)}` };
  }
}

export interface ExplanationNote {
  attemptId: string;
  explanation: string;
  correctedText: string | null;
  example: string | null;
  tip: string | null;
}

export type FinishResult =
  | { status: "saved" | "already_saved"; count: number }
  | { status: "conflict" | "invalid_token" | "invalid_state" | "not_found" }
  | { status: "invalid_payload"; reason: string }
  | { status: "error"; message: string };

export async function finishExplanations(
  service: SupabaseClient,
  args: { userId: string; roundId: string; operationId: string; token: string; notes: ExplanationNote[] }
): Promise<FinishResult> {
  const { data, error } = await service.rpc("fn_explanations_finish", {
    p_user_id: args.userId,
    p_round_id: args.roundId,
    p_operation_id: args.operationId,
    p_token: args.token,
    p_items: args.notes.map((n) => ({
      attemptId: n.attemptId,
      explanation: n.explanation,
      correctedText: n.correctedText,
      example: n.example,
      tip: n.tip,
    })),
  });
  if (error || !data || typeof data !== "object") {
    return { status: "error", message: error?.message ?? "no result" };
  }
  const d = data as Record<string, unknown>;
  if (d.status === "saved" || d.status === "already_saved") return { status: d.status, count: Number(d.count ?? 0) };
  if (d.status === "invalid_payload") return { status: "invalid_payload", reason: String(d.reason ?? "") };
  if (d.status === "conflict" || d.status === "invalid_token" || d.status === "invalid_state" || d.status === "not_found") {
    return { status: d.status };
  }
  return { status: "error", message: `unexpected status ${String(d.status)}` };
}

export type AbandonReason = "quota_denied" | "provider_failed" | "unparseable" | "no_usable_notes" | "invalid_output" | "not_configured";

/** Best-effort: never throws. A failed abandon only means the lease expires on its own (120 s). */
export async function abandonExplanations(
  service: SupabaseClient,
  args: { userId: string; roundId: string; operationId: string; token: string; reason: AbandonReason }
): Promise<void> {
  try {
    const { error } = await service.rpc("fn_explanations_abandon", {
      p_user_id: args.userId,
      p_round_id: args.roundId,
      p_operation_id: args.operationId,
      p_token: args.token,
      p_reason: args.reason,
    });
    if (error) console.error("[explanations] abandon failed:", error);
  } catch (err) {
    console.error("[explanations] abandon threw:", err);
  }
}

/** Keeps only notes a finish can accept: explained, non-blank, one per target. */
export function usableNotes(candidates: ExplanationNote[], targets: Set<string>): ExplanationNote[] {
  const seen = new Set<string>();
  const out: ExplanationNote[] = [];
  for (const c of candidates) {
    if (!targets.has(c.attemptId) || seen.has(c.attemptId)) continue;
    if (typeof c.explanation !== "string" || c.explanation.trim() === "") continue;
    seen.add(c.attemptId);
    out.push({
      attemptId: c.attemptId,
      explanation: c.explanation.slice(0, 4000),
      correctedText: typeof c.correctedText === "string" ? c.correctedText.slice(0, 2000) : null,
      example: typeof c.example === "string" ? c.example.slice(0, 2000) : null,
      tip: typeof c.tip === "string" && c.tip.trim() !== "" ? c.tip.slice(0, 1000) : null,
    });
  }
  return out;
}
