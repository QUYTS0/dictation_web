/**
 * Learning Reports P5 — saving a generated result whose first save failed.
 * SERVER-ONLY. Never calls Gemini and never touches quota.
 *
 * Each entry is verified independently: the sealed token opens with the
 * server secret (integrity + confidentiality), has not expired (24 h), names
 * THIS user and round, and the submitted payload/meta hash exactly to the
 * sealed hashes. Then the SAME finish RPC as a direct save runs, so the
 * database decides idempotency (already saved / conflict / superseded).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { contentHash, getAiRecoverySecret, openAiRecovery } from "@/lib/ai/aiRecovery";
import { finishAssessment } from "@/lib/ai/assessmentPersistence";
import { finishExplanations, type ExplanationNote } from "@/lib/practice/explanationPersistence";
import type { AiRecoverResponse } from "@/lib/ai/types";

type Status = AiRecoverResponse["results"][number]["status"];

export async function runRecover(
  d: { service: SupabaseClient; userId: string; roundId: string; secret?: string | null; nowSec?: number },
  entries: unknown[]
): Promise<{ httpStatus: number; body: AiRecoverResponse | { error: string; code: string } }> {
  const secret = d.secret === undefined ? getAiRecoverySecret() : d.secret;
  if (!secret) return { httpStatus: 503, body: { error: "Saving isn't available on this server right now.", code: "ai_not_configured" } };
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 2) {
    return { httpStatus: 400, body: { error: "entries must hold 1–2 items.", code: "bad_request" } };
  }
  const results: AiRecoverResponse["results"] = [];
  for (const raw of entries) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const op = e.op === "overview" || e.op === "explanations" ? e.op : null;
    if (!op) {
      results.push({ op: "overview", status: "invalid" });
      continue;
    }
    const opened = openAiRecovery(secret, e.token, d.nowSec);
    if (!opened.ok) {
      results.push({ op, status: opened.reason === "expired" ? "expired" : "invalid" });
      continue;
    }
    const c = opened.claims;
    if (c.op !== op || c.userId !== d.userId || c.roundId !== d.roundId) {
      results.push({ op, status: "invalid" });
      continue;
    }
    if (c.op === "overview") {
      if (contentHash(e.payload) !== c.payloadHash || contentHash(e.meta) !== c.metaHash) {
        results.push({ op, status: "invalid" });
        continue;
      }
      const fin = await finishAssessment(d.service, {
        userId: c.userId,
        roundId: c.roundId,
        generation: c.generation,
        token: c.token,
        fingerprint: c.fingerprint,
        promptVersion: c.promptVersion,
        model: c.model,
        payload: e.payload,
        meta: e.meta,
      });
      results.push({ op, status: mapOverview(fin.status) });
    } else {
      const items = e.items;
      if (!Array.isArray(items) || contentHash(items) !== c.payloadHash) {
        results.push({ op, status: "invalid" });
        continue;
      }
      const notes = (items as Record<string, unknown>[]).map(
        (i): ExplanationNote => ({
          attemptId: String(i.attemptId),
          explanation: String(i.explanation),
          correctedText: (i.correctedText as string | null) ?? null,
          example: (i.example as string | null) ?? null,
          tip: (i.tip as string | null) ?? null,
          ...(i.kind ? { kind: i.kind as ExplanationNote["kind"], refAttemptId: (i.refAttemptId as string | null) ?? null } : {}),
        })
      );
      const fin = await finishExplanations(d.service, { userId: c.userId, roundId: c.roundId, operationId: c.operationId, token: c.token, notes });
      results.push({
        op,
        status:
          fin.status === "saved" || fin.status === "already_saved" ? "saved" : fin.status === "conflict" ? "conflict" : fin.status === "error" ? "not_saved" : "rejected",
      });
    }
  }
  return { httpStatus: 200, body: { results } };
}

function mapOverview(s: string): Status {
  if (s === "accepted" || s === "already_accepted") return "saved";
  if (s === "superseded") return "superseded";
  if (s === "conflict") return "conflict";
  if (s === "error") return "not_saved";
  return "rejected";
}
