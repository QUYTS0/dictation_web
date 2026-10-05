/**
 * Learning Reports P5 — the report route's AI block. READ-ONLY: owner RLS
 * selects only (no RPC, no write, no provider call). SERVER-ONLY.
 *
 * Fallback rule (plan §10.2): an ACCEPTED new-format assessment wins; until
 * one exists, the legacy assessment stays visible — even while a generation
 * is started, in progress, abandoned or expired.
 * Freshness (learning-data fingerprint) and content version (prompt/model)
 * are reported separately; neither ever triggers generation.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildAssessmentInput, type AssessmentAttemptRow } from "@/lib/ai/assessmentInput";
import { ASSESSMENT_PROMPT_VERSION } from "@/lib/ai/assessmentPrompt";
import { GEMINI_MODEL_NAME } from "@/lib/gemini";
import type { StoredExplanation } from "@/lib/practice/explanationIdentity";
import type { RoundReport } from "@/lib/types/learning";
import type { SessionAssessment } from "@/lib/types";
import type { AssessmentMetaView, OverviewPayloadView, ReportAiView } from "@/lib/ai/types";

interface AcceptedRow {
  accepted_generation: number | null;
  accepted_fingerprint: string | null;
  accepted_prompt_version: number | null;
  accepted_model: string | null;
  accepted_payload: OverviewPayloadView | null;
  accepted_meta: AssessmentMetaView | null;
  accepted_at: string | null;
  latest_started_generation: number;
}
interface GenerationRow {
  generation: number;
  state: string;
  lease_expires_at: string | null;
}

export function buildReportAiView(args: {
  report: RoundReport;
  attempts: AssessmentAttemptRow[];
  notes: StoredExplanation[];
  accepted: AcceptedRow | null;
  latest: GenerationRow | null;
  legacy: { assessment: SessionAssessment | null; generatedAt: string | null };
  now: Date;
  model?: string;
}): ReportAiView {
  const input = buildAssessmentInput({ report: args.report, attempts: args.attempts, notes: args.notes });
  const model = args.model ?? GEMINI_MODEL_NAME;
  const a = args.accepted;
  const accepted =
    a && a.accepted_generation !== null && a.accepted_payload
      ? {
          payload: a.accepted_payload,
          meta: a.accepted_meta,
          acceptedAt: a.accepted_at ?? "",
          fresh: a.accepted_fingerprint === input.fingerprint,
          contentCurrent: a.accepted_prompt_version === ASSESSMENT_PROMPT_VERSION && a.accepted_model === model,
        }
      : null;
  const l = args.legacy.assessment;
  const legacy =
    !accepted && l
      ? { verdict: l.verdict ?? "", strengths: l.strengths ?? [], weaknesses: l.weaknesses ?? [], recommendation: l.recommendation ?? "", generatedAt: args.legacy.generatedAt }
      : null;
  const generating =
    !!args.latest && args.latest.state === "started" && !!args.latest.lease_expires_at && Date.parse(args.latest.lease_expires_at) > args.now.getTime();
  return {
    accepted,
    legacy,
    generating,
    targets: { total: input.targets.length, missing: input.missingTargets.length },
    current: { promptVersion: ASSESSMENT_PROMPT_VERSION, model },
  };
}

/** Owner-scoped reads of the accepted assessment and the latest generation's state. */
export async function readAssessmentRows(
  userClient: SupabaseClient,
  roundId: string
): Promise<{ ok: true; accepted: AcceptedRow | null; latest: GenerationRow | null } | { ok: false }> {
  const { data: ra, error } = await userClient
    .from("round_assessments")
    .select("accepted_generation, accepted_fingerprint, accepted_prompt_version, accepted_model, accepted_payload, accepted_meta, accepted_at, latest_started_generation")
    .eq("round_id", roundId)
    .maybeSingle();
  if (error) return { ok: false };
  const row = (ra as AcceptedRow | null) ?? null;
  if (!row || row.latest_started_generation < 1) return { ok: true, accepted: row, latest: null };
  const { data: g, error: gError } = await userClient
    .from("assessment_generations")
    .select("generation, state, lease_expires_at")
    .eq("round_id", roundId)
    .eq("generation", row.latest_started_generation)
    .maybeSingle();
  if (gError) return { ok: false };
  return { ok: true, accepted: row, latest: (g as GenerationRow | null) ?? null };
}
