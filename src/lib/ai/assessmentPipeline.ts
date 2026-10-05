/**
 * Learning Reports P5 — "Generate assessment" and "Explain more", end to end.
 * SERVER-ONLY.
 *
 *   load owned round → build input → begin (DB, short transaction, per-round
 *   lock) → admission + provider call OUTSIDE any transaction (attempt 1;
 *   attempt 2 only for an unreadable response, admitted separately) →
 *   validate → finish each operation independently → recovery token for
 *   anything generated but not stored.
 *
 * Only operations this request began are ever abandoned. A failed or
 * unusable generation never touches the saved assessment or notes.
 * Not exactly-once: see supabase/P5_ASSESSMENT_RUNBOOK.md §2.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { GEMINI_MODEL_NAME } from "@/lib/gemini";
import {
  buildAssessmentInput,
  explanationBatchSize,
  selectBatch,
  type AssessmentAttemptRow,
  type AssessmentInput,
  type ExplanationTarget,
} from "@/lib/ai/assessmentInput";
import {
  ASSESSMENT_PROMPT_VERSION,
  EXPLANATION_PROMPT_VERSION,
  NOTES_RESERVE_TOKENS,
  NOTES_SCHEMA,
  OUTPUT_TOKENS,
  OVERVIEW_RESERVE_TOKENS,
  OVERVIEW_SCHEMA,
  SYSTEM_INSTRUCTION,
  buildNotesPrompt,
  buildOverviewPrompt,
  targetIds,
} from "@/lib/ai/assessmentPrompt";
import { noteItem, validateNotes, validateOverview, type ValidNote } from "@/lib/ai/assessmentValidate";
import { abandonAssessment, beginAssessment, finishAssessment } from "@/lib/ai/assessmentPersistence";
import { abandonExplanations, beginExplanations, finishExplanations, type AbandonReason } from "@/lib/practice/explanationPersistence";
import { admissionFailure, callGeminiAdmitted, parseJsonText, type GeminiCallResult } from "@/lib/ai/geminiCall";
import { geminiFailureMessage } from "@/lib/ai/geminiErrors";
import { contentHash, getAiRecoverySecret, sealAiRecovery } from "@/lib/ai/aiRecovery";
import type { StoredExplanation } from "@/lib/practice/explanationIdentity";
import type { RoundReport } from "@/lib/types/learning";
import type { AiActionResponse, AiSaveStatus, AssessmentMetaView, OverviewPayloadView } from "@/lib/ai/types";

export const NOTE_COLUMNS =
  "id, attempt_id, source, seq, explanation, corrected_text, example_text, tip, prompt_version, model, created_at, note_kind, ref_attempt_id";
export const ATTEMPT_COLUMNS = "id, segment_index, expected_text, user_text, is_correct, is_practice_valid, match_mode, created_at";
const TIMEOUT_MS = 55_000;

export interface PipelineDeps {
  userClient: SupabaseClient;
  service: SupabaseClient;
  userId: string;
  roundId: string;
  call?: typeof callGeminiAdmitted;
  apiKey?: string | null;
  secret?: string | null;
  model?: string;
  now?: () => Date;
}

export type PipelineResult = { httpStatus: number; body: AiActionResponse | { error: string; code: string } };

const fail = (httpStatus: number, code: string, error: string): PipelineResult => ({ httpStatus, body: { error, code } });

/** Loads the owned round's data (RLS for ownership; service read for notes). */
export async function loadRoundForAi(
  d: Pick<PipelineDeps, "userClient" | "service" | "userId" | "roundId">
): Promise<{ ok: true; report: RoundReport; attempts: AssessmentAttemptRow[]; notes: StoredExplanation[] } | { ok: false; result: PipelineResult }> {
  const { data: round, error: roundError } = await d.userClient
    .from("learning_sessions")
    .select("id")
    .eq("id", d.roundId)
    .eq("user_id", d.userId)
    .maybeSingle();
  if (roundError) return { ok: false, result: fail(500, "load_failed", "Failed to load the round.") };
  if (!round) return { ok: false, result: fail(404, "not_found", "Round not found.") };
  const [{ data: attempts, error: attemptsError }, { data: report, error: reportError }, { data: notes, error: notesError }] = await Promise.all([
    d.userClient.from("attempt_logs").select(ATTEMPT_COLUMNS).eq("session_id", d.roundId),
    d.userClient.rpc("fn_round_report", { p_round_id: d.roundId }),
    d.service.from("attempt_explanations").select(NOTE_COLUMNS).eq("round_id", d.roundId),
  ]);
  if (attemptsError || reportError || !report) return { ok: false, result: fail(500, "load_failed", "Failed to load the round.") };
  if (notesError) {
    return { ok: false, result: fail(503, "notes_unavailable", "Saved explanations couldn't be checked. Nothing was requested or charged.") };
  }
  return { ok: true, report: report as RoundReport, attempts: (attempts ?? []) as AssessmentAttemptRow[], notes: (notes ?? []) as StoredExplanation[] };
}

function preflight(d: PipelineDeps): PipelineResult | null {
  const apiKey = d.apiKey === undefined ? process.env.GEMINI_API_KEY : d.apiKey;
  const secret = d.secret === undefined ? getAiRecoverySecret() : d.secret;
  // Checked BEFORE any begin or quota: a result we couldn't recover must not be paid for.
  if (!apiKey || !secret) return fail(503, "ai_not_configured", "AI isn't configured on this server. Saved results stay available.");
  return null;
}

interface CallOutcome {
  parsed: Record<string, unknown> | null;
  last: GeminiCallResult | null;
  requestsUsed: number;
  /** Early stop: the admission or provider failure response. */
  failure: PipelineResult | null;
}

/** Attempt 1, and attempt 2 only when attempt 1's text isn't readable JSON. */
async function callWithOneRetry(
  d: PipelineDeps,
  args: { operationType: "assessment" | "explanations"; operationId: string; prompt: string; schema: typeof OVERVIEW_SCHEMA; accept: (v: Record<string, unknown>) => boolean }
): Promise<CallOutcome> {
  const call = d.call ?? callGeminiAdmitted;
  const apiKey = (d.apiKey === undefined ? process.env.GEMINI_API_KEY : d.apiKey) as string;
  let requestsUsed = 0;
  let last: GeminiCallResult | null = null;
  for (const attempt of [1, 2] as const) {
    last = await call({
      apiKey,
      model: d.model ?? GEMINI_MODEL_NAME,
      prompt: args.prompt,
      systemInstruction: SYSTEM_INSTRUCTION,
      responseSchema: args.schema,
      maxOutputTokens: OUTPUT_TOKENS,
      timeoutMs: TIMEOUT_MS,
      admission: { operationType: args.operationType, operationId: args.operationId, attempt, userId: d.userId },
      logTag: `ai/${args.operationType}`,
    });
    if (last.status === "not_admitted") {
      if (attempt === 1) {
        const f = admissionFailure(last.admission);
        return { parsed: null, last, requestsUsed, failure: fail(f.status, f.code, f.error) };
      }
      return {
        parsed: null,
        last,
        requestsUsed,
        failure: fail(502, "unreadable", "The AI response couldn't be read, and no AI request was left for a retry. Nothing was saved; earlier results are kept."),
      };
    }
    requestsUsed++;
    if (last.status === "provider_error") {
      return {
        parsed: null,
        last,
        requestsUsed,
        failure: fail(502, "provider_failed", geminiFailureMessage(last.diagnostics)),
      };
    }
    const parsed = parseJsonText(last.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && args.accept(parsed as Record<string, unknown>)) {
      return { parsed: parsed as Record<string, unknown>, last, requestsUsed, failure: null };
    }
  }
  return {
    parsed: null,
    last,
    requestsUsed,
    failure: fail(502, "unreadable", "The AI response couldn't be read (2 AI requests used). Nothing was saved; earlier results are kept."),
  };
}

function sealOrNull(d: PipelineDeps, claims: Parameters<typeof sealAiRecovery>[1]): string {
  const secret = (d.secret === undefined ? getAiRecoverySecret() : d.secret) as string;
  return sealAiRecovery(secret, claims);
}

async function saveNotes(
  d: PipelineDeps,
  op: { operationId: string; token: string },
  notes: ValidNote[],
  targets: ExplanationTarget[],
  promptVersion: number,
  model: string
): Promise<Pick<AiActionResponse["explanations"], "status" | "saved" | "unsaved" | "recovery">> {
  const abandon = (reason: AbandonReason) => abandonExplanations(d.service, { userId: d.userId, roundId: d.roundId, ...op, reason });
  if (notes.length === 0) {
    await abandon("no_usable_notes");
    return { status: "none_usable", saved: 0 };
  }
  const items = notes.map(noteItem);
  const finish = await finishExplanations(d.service, {
    userId: d.userId,
    roundId: d.roundId,
    ...op,
    notes: notes.map((n) => ({ attemptId: n.attemptId, explanation: n.explanation, correctedText: n.correctedText, example: n.example, tip: n.tip, kind: n.kind, refAttemptId: n.refAttemptId })),
  });
  if (finish.status === "saved" || finish.status === "already_saved") return { status: "saved", saved: finish.count };
  if (finish.status === "conflict") return { status: "conflict", saved: 0 };
  if (finish.status !== "error") {
    if (finish.status === "invalid_payload") await abandon("invalid_output");
    return { status: "rejected", saved: 0 };
  }
  // DB unreachable: the operation stays started (lease expires on its own)
  // so the signed recovery can still finish it.
  const recovery = {
    op: "explanations" as const,
    token: sealOrNull(d, {
      op: "explanations",
      userId: d.userId,
      roundId: d.roundId,
      operationId: op.operationId,
      token: op.token,
      targets: targets.map((t) => t.attemptId),
      promptVersion,
      model,
      payloadHash: contentHash(items),
    }),
    items,
  };
  return {
    status: "not_saved",
    saved: 0,
    unsaved: notes.map((n) => ({ attemptId: n.attemptId, kind: n.kind, explanation: n.explanation, correctedText: n.correctedText, example: n.example, refAttemptId: n.refAttemptId })),
    recovery,
  };
}

/** "Generate / Update / Regenerate assessment": the overview plus the first missing batch (≤ 35). */
export async function runGenerate(d: PipelineDeps): Promise<PipelineResult> {
  const pre = preflight(d);
  if (pre) return pre;
  const loaded = await loadRoundForAi(d);
  if (!loaded.ok) return loaded.result;
  const input = buildAssessmentInput({ report: loaded.report, attempts: loaded.attempts, notes: loaded.notes });
  const model = d.model ?? GEMINI_MODEL_NAME;
  const now = (d.now ?? (() => new Date()))();

  const begin = await beginAssessment(d.service, { userId: d.userId, roundId: d.roundId, fingerprint: input.fingerprint, promptVersion: ASSESSMENT_PROMPT_VERSION, model });
  if (begin.status === "reuse") {
    return {
      httpStatus: 200,
      body: {
        action: "generate",
        overview: { status: "reused" },
        explanations: { status: "not_requested", requested: 0, valid: 0, saved: 0, missing: 0, remaining: input.missingTargets.length },
        truncated: false,
        requestsUsed: 0,
      },
    };
  }
  if (begin.status === "in_progress") return fail(409, "in_progress", "This assessment is already being generated. It will appear here when it's ready.");
  if (begin.status === "busy") return fail(409, "busy", "Another assessment for this round is being generated. Try again shortly — nothing was charged.");
  if (begin.status === "outdated_app") return fail(409, "outdated_app", "A newer version of the app made this assessment. Reload the page — nothing was charged.");
  if (begin.status === "not_found") return fail(404, "not_found", "Round not found.");
  if (begin.status !== "started") return fail(503, "begin_failed", "The assessment couldn't be prepared. Nothing was requested or charged.");
  const gen = { generation: begin.generation, token: begin.token };
  const abandonOverview = (reason: string) => abandonAssessment(d.service, { userId: d.userId, roundId: d.roundId, ...gen, reason });

  // First missing explanation batch, admitted by the database under the lock.
  let targets: ExplanationTarget[] = [];
  let op: { operationId: string; token: string } | null = null;
  let notesStatus: AiSaveStatus | "no_targets" = "no_targets";
  const batch = selectBatch(input, explanationBatchSize(OUTPUT_TOKENS, OVERVIEW_RESERVE_TOKENS), { onlyMissing: true });
  if (batch.length > 0) {
    const b = await beginExplanations(d.service, {
      userId: d.userId,
      roundId: d.roundId,
      targetAttemptIds: batch.map((t) => t.attemptId),
      kind: "batch",
      intent: "missing",
      promptVersion: EXPLANATION_PROMPT_VERSION,
      model,
    });
    if (b.status === "started") {
      op = { operationId: b.operationId, token: b.token };
      const admitted = new Set(b.targets);
      targets = batch.filter((t) => admitted.has(t.attemptId));
    } else if (b.status === "reuse") notesStatus = "reused";
    else if (b.status === "in_progress" || b.status === "busy") notesStatus = "skipped_busy";
    else notesStatus = "not_requested";
  }
  const abandonNotes = (reason: AbandonReason) =>
    op ? abandonExplanations(d.service, { userId: d.userId, roundId: d.roundId, ...op, reason }) : Promise.resolve();
  const abandonBoth = async (reason: AbandonReason) => {
    await abandonOverview(reason);
    await abandonNotes(reason);
  };

  const outcome = await callWithOneRetry(d, {
    operationType: "assessment",
    operationId: `overview:${d.roundId}:${gen.generation}`,
    prompt: buildOverviewPrompt(input, targets),
    schema: OVERVIEW_SCHEMA,
    accept: (v) => "overview" in v || "sentenceNotes" in v,
  });
  if (outcome.failure) {
    const code = (outcome.failure.body as { code: string }).code;
    await abandonBoth(
      code === "provider_failed" ? "provider_failed" : code === "unreadable" ? "unparseable" : code === "unknown_outcome" ? "unknown_outcome" : code === "quota_unavailable" ? "quota_unavailable" : "quota_denied"
    );
    return outcome.failure;
  }
  const parsed = outcome.parsed!;
  const truncated = outcome.last?.status === "ok" && outcome.last.truncated;

  const ids = targetIds(targets);
  const { notes, coverage } = validateNotes(parsed.sentenceNotes, ids);
  const ov = validateOverview(parsed, input.evidence);

  // ---- overview
  let overview: AiActionResponse["overview"];
  if (!ov.payload) {
    await abandonOverview("invalid_output");
    overview = { status: "unusable" };
  } else {
    const meta: AssessmentMetaView = {
      generatedAt: now.toISOString(),
      promptVersion: ASSESSMENT_PROMPT_VERSION,
      model,
      evidence: { individual: input.individual.length, aggregateOnly: input.aggregates.sentences, total: input.evidence.length },
      notes: { requested: targets.length, valid: coverage.valid },
      truncated: !!truncated,
      droppedStrengths: ov.droppedStrengths,
      droppedPriorities: ov.droppedPriorities,
    };
    const payload: OverviewPayloadView = ov.payload;
    const fin = await finishAssessment(d.service, {
      userId: d.userId,
      roundId: d.roundId,
      ...gen,
      fingerprint: input.fingerprint,
      promptVersion: ASSESSMENT_PROMPT_VERSION,
      model,
      payload,
      meta,
    });
    if (fin.status === "accepted" || fin.status === "already_accepted") overview = { status: "saved", payload, meta };
    else if (fin.status === "superseded") overview = { status: "superseded" };
    else if (fin.status === "conflict") overview = { status: "conflict" };
    else if (fin.status === "error") {
      overview = {
        status: "not_saved",
        payload,
        meta,
        recovery: {
          op: "overview",
          token: sealOrNull(d, {
            op: "overview",
            userId: d.userId,
            roundId: d.roundId,
            generation: gen.generation,
            token: gen.token,
            fingerprint: input.fingerprint,
            promptVersion: ASSESSMENT_PROMPT_VERSION,
            model,
            payloadHash: contentHash(payload),
            metaHash: contentHash(meta),
          }),
          payload,
          meta,
        },
      };
    } else {
      await abandonOverview("rejected");
      overview = { status: "rejected" };
    }
  }

  // ---- notes (independent of the overview's outcome)
  const remainingAfter = (saved: boolean) => Math.max(0, input.missingTargets.length - (saved ? coverage.valid : 0));
  let explanations: AiActionResponse["explanations"];
  if (!op) {
    explanations = { status: notesStatus, requested: 0, valid: 0, saved: 0, missing: 0, remaining: input.missingTargets.length };
  } else {
    const s = await saveNotes(d, op, notes, targets, EXPLANATION_PROMPT_VERSION, model);
    explanations = { ...s, requested: targets.length, valid: coverage.valid, missing: coverage.missing, remaining: remainingAfter(s.status === "saved") };
  }

  return { httpStatus: 200, body: { action: "generate", overview, explanations, truncated: !!truncated, requestsUsed: outcome.requestsUsed } };
}

/** "Explain more" (missing only) or "Re-explain" (explicit sentences): notes only, never the overview. */
export async function runExplain(d: PipelineDeps, req: { intent: "missing" | "reexplain"; sentences?: number[] }): Promise<PipelineResult> {
  const pre = preflight(d);
  if (pre) return pre;
  if (req.intent === "reexplain" && (!req.sentences || req.sentences.length === 0)) {
    return fail(400, "bad_request", "Choose the sentences to re-explain.");
  }
  const loaded = await loadRoundForAi(d);
  if (!loaded.ok) return loaded.result;
  const input: AssessmentInput = buildAssessmentInput({ report: loaded.report, attempts: loaded.attempts, notes: loaded.notes });
  const model = d.model ?? GEMINI_MODEL_NAME;
  const targetsWanted = selectBatch(input, explanationBatchSize(OUTPUT_TOKENS, NOTES_RESERVE_TOKENS), {
    sentences: req.sentences,
    onlyMissing: req.intent === "missing",
  });
  const unchanged = (status: AiSaveStatus | "no_targets"): PipelineResult => ({
    httpStatus: 200,
    body: {
      action: "explain",
      overview: { status: "not_requested" },
      explanations: { status, requested: 0, valid: 0, saved: 0, missing: 0, remaining: input.missingTargets.length },
      truncated: false,
      requestsUsed: 0,
    },
  });
  if (targetsWanted.length === 0) return unchanged(input.missingTargets.length === 0 && req.intent === "missing" ? (input.targets.length ? "reused" : "no_targets") : "no_targets");

  const b = await beginExplanations(d.service, {
    userId: d.userId,
    roundId: d.roundId,
    targetAttemptIds: targetsWanted.map((t) => t.attemptId),
    kind: "batch",
    intent: req.intent,
    promptVersion: EXPLANATION_PROMPT_VERSION,
    model,
  });
  if (b.status === "reuse") return unchanged("reused");
  if (b.status === "in_progress" || b.status === "busy") return fail(409, b.status, "Explanations for this round are already being generated. Try again shortly — nothing was charged.");
  if (b.status === "not_found") return fail(404, "not_found", "Round not found.");
  if (b.status !== "started") return fail(503, "begin_failed", "Explanations couldn't be prepared. Nothing was requested or charged.");
  const op = { operationId: b.operationId, token: b.token };
  const admitted = new Set(b.targets);
  const targets = targetsWanted.filter((t) => admitted.has(t.attemptId));

  const outcome = await callWithOneRetry(d, {
    operationType: "explanations",
    operationId: `explanations:${d.roundId}:${op.operationId}`,
    prompt: buildNotesPrompt(targets),
    schema: NOTES_SCHEMA,
    accept: (v) => Array.isArray(v.sentenceNotes),
  });
  if (outcome.failure) {
    const code = (outcome.failure.body as { code: string }).code;
    await abandonExplanations(d.service, {
      userId: d.userId,
      roundId: d.roundId,
      ...op,
      reason: code === "provider_failed" ? "provider_failed" : code === "unreadable" ? "unparseable" : code === "unknown_outcome" ? "unknown_outcome" : code === "quota_unavailable" ? "quota_unavailable" : "quota_denied",
    });
    return outcome.failure;
  }
  const truncated = outcome.last?.status === "ok" && outcome.last.truncated;
  const { notes, coverage } = validateNotes(outcome.parsed!.sentenceNotes, targetIds(targets));
  const s = await saveNotes(d, op, notes, targets, EXPLANATION_PROMPT_VERSION, model);
  const remaining = req.intent === "missing" && s.status === "saved" ? Math.max(0, input.missingTargets.length - coverage.valid) : input.missingTargets.length;
  return {
    httpStatus: 200,
    body: {
      action: "explain",
      overview: { status: "not_requested" },
      explanations: { ...s, requested: targets.length, valid: coverage.valid, missing: coverage.missing, remaining },
      truncated: !!truncated,
      requestsUsed: outcome.requestsUsed,
    },
  };
}
