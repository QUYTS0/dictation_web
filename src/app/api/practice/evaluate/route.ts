import { NextRequest, NextResponse } from "next/server";
import { assessPronunciation, isAzureSpeechConfigured, AzureSpeechError } from "@/lib/azureSpeech";
import { reservePracticeQuota, recordPracticeUsage } from "@/lib/practiceQuota";
import { checkRateLimit } from "@/lib/rateLimit";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mapPracticeEvaluationError } from "@/lib/supabase/practiceEvaluationErrors";
import { isUuid } from "@/lib/practice/validation";
import { getRecoverySecret, issueRecoveryToken, RECOVERY_TOKEN_TTL_SEC } from "@/lib/practice/recoveryToken";
import { finishAzureFailed, persistWithRetry, toStoredAzureResult } from "@/lib/practice/azureEvaluation";
import { MAX_AUDIO_BYTES, validatePcmWav } from "@/lib/practice/wavValidation";
import type { EvaluateAttemptResponse } from "@/lib/practice/shadowingTypes";

type BeginResult =
  | {
      admitted: true;
      outcome: "admitted";
      attemptId: string;
      seq: number;
      referenceText: string;
      recordingDurationSec: number;
    }
  | { admitted: false; outcome: "in_progress"; attemptId: string; seq: number; requestedAt: string; expiresAt: string }
  | { admitted: false; outcome: "already_evaluated"; attemptId: string; seq: number };

function log(event: string, fields: Record<string, unknown>) {
  // Identifiers and outcomes only — never audio, tokens, secrets or provider payloads.
  console.log(`[practice/evaluate] ${event}`, JSON.stringify(fields));
}

/**
 * Attempt-scoped Azure Pronunciation Assessment (plan §9.4). An explicit
 * user action on an already-SAVED recording:
 *   request: multipart { attemptId, audio } — no reference text, no scores;
 *   1. configuration (Azure + recovery signing secret) is checked before
 *      anything is spent;
 *   2. the audio is validated as the app's PCM WAV (16 kHz mono 16-bit, ≤ 21 s)
 *      and its duration derived from the sample data — before anything else;
 *   3. the caller is authenticated (GoTrue); fn_begin_azure_evaluation locks
 *      THIS attempt only, re-checks ownership + relationships, resolves the
 *      reference text from the pinned sentence and admits at most one live
 *      request per recording (a duplicate gets evaluation_in_progress with
 *      nothing changed; a completed recording gets azure_already_evaluated);
 *   4. quota is checked with the server-derived duration (a check failure
 *      refuses the call and records a retryable failure);
 *   5. Azure is called (the row lock is long released);
 *   6. usage is recorded best effort — an accounting error never discards
 *      the paid result;
 *   7. the result is written for (attempt, user, seq) only; a database
 *      failure after a paid result yields persisted:false plus a server-signed
 *      recovery token.
 * A request without attemptId comes from a pre-Phase-4 page: 409
 * stale_client_version / reload_required, never guessed.
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "practice/evaluate", { limit: 10, windowMs: 60_000 });
  if (rateLimitResponse) return rateLimitResponse;

  if (!isAzureSpeechConfigured()) {
    return NextResponse.json({ error: "Evaluation engine not configured." }, { status: 503 });
  }
  const recoverySecret = getRecoverySecret();
  if (!recoverySecret) {
    // Without it a paid result could be lost to a transient database error
    // — refuse before spending anything.
    console.error("[practice/evaluate] AZURE_RECOVERY_SIGNING_SECRET missing or shorter than 32 characters");
    return NextResponse.json(
      { error: "Pronunciation scoring isn't fully set up for this site yet.", code: "evaluation_not_configured" },
      { status: 503 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const attemptId = formData.get("attemptId");
  if (attemptId === null) {
    return NextResponse.json(
      {
        error: "This page is out of date. Reload it to keep evaluating your recordings.",
        code: "stale_client_version",
        action: "reload_required",
      },
      { status: 409 }
    );
  }
  if (!isUuid(attemptId)) {
    return NextResponse.json({ error: "Invalid attemptId.", code: "invalid_payload" }, { status: 400 });
  }
  const audio = formData.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: "audio is required.", code: "invalid_payload" }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Recording is too large to evaluate.", code: "audio_too_large" }, { status: 413 });
  }
  const wavBuffer = Buffer.from(await audio.arrayBuffer());
  const wav = validatePcmWav(wavBuffer);
  if (!wav.ok) {
    log("audio_rejected", { attemptId, reason: wav.reason, bytes: wavBuffer.byteLength });
    return NextResponse.json(
      { error: "That recording couldn't be read. Record the sentence again.", code: "audio_invalid", reason: wav.reason },
      { status: wav.reason === "too_large" || wav.reason === "too_long" ? 413 : 400 }
    );
  }
  const audioDurationSec = Math.round(wav.durationSec * 1000) / 1000;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const service = createServiceClient();
  const { data: begunRaw, error: beginError } = await service.rpc("fn_begin_azure_evaluation", {
    p_attempt_id: attemptId,
    p_user_id: user.id,
    p_audio_duration_sec: audioDurationSec,
  });
  if (beginError || !begunRaw) return mapPracticeEvaluationError(beginError, "Failed to start the evaluation.");
  const begun = begunRaw as BeginResult;
  if (!begun.admitted) {
    log("not_admitted", { attemptId, outcome: begun.outcome, seq: begun.seq });
    if (begun.outcome === "in_progress") {
      // Nothing was spent or changed. The page reads the running request's
      // result via GET /api/practice/attempt/[attemptId].
      const retryAfterSec = Math.max(1, Math.ceil((Date.parse(begun.expiresAt) - Date.now()) / 1000));
      const res = NextResponse.json(
        {
          error: "This recording is already being evaluated.",
          code: "evaluation_in_progress",
          attemptId,
          seq: begun.seq,
          expiresAt: begun.expiresAt,
        },
        { status: 409 }
      );
      res.headers.set("Retry-After", String(retryAfterSec));
      return res;
    }
    return NextResponse.json(
      { error: "This recording has already been evaluated.", code: "azure_already_evaluated", attemptId, seq: begun.seq },
      { status: 409 }
    );
  }
  const { seq, referenceText } = begun;
  const claims = { attemptId, userId: user.id, seq };

  // Quota by the duration derived from the validated audio (the stored
  // recording_duration_sec is client-reported practice metadata and was only
  // used by fn_begin_azure_evaluation to reject a mismatching upload).
  // The quota is an APPROXIMATE monthly limit, not a strict budget:
  // reservePracticeQuota only READS the counter (nothing is reserved), so
  // concurrent evaluations of different recordings can pass the check
  // together; usage is added after a successful call. If this read fails,
  // this request does not call Azure.
  let allowed: boolean;
  try {
    allowed = (await reservePracticeQuota(audioDurationSec)).allowed;
  } catch (err) {
    console.error("[practice/evaluate] quota check failed:", (err as Error)?.message);
    await finishAzureFailed(service, claims, "quota_unavailable");
    return NextResponse.json(
      { error: "Pronunciation scoring is temporarily unavailable. Please try again shortly.", code: "quota_unavailable", retryable: true },
      { status: 503 }
    );
  }
  if (!allowed) {
    await finishAzureFailed(service, claims, "quota_exceeded");
    return NextResponse.json(
      { error: "quota-exceeded", message: "Monthly free evaluation limit reached." },
      { status: 429 }
    );
  }

  let azure;
  try {
    azure = await assessPronunciation({ wavBuffer, referenceText });
  } catch (err) {
    const message = err instanceof AzureSpeechError ? err.message : "Evaluation failed. Please try again.";
    log("provider_failed", { attemptId, seq, message });
    // Practice credit is untouched: only this attempt's evaluation fails.
    // No usage is recorded for a failed call (existing policy) — including
    // a timeout, where Azure may or may not have processed the audio.
    await finishAzureFailed(service, claims, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Attempted once per admitted (attempt, seq): admission never lets a second
  // request for this seq reach here, and persistence recovery neither calls
  // Azure nor records usage. The write can fail even when the read above
  // succeeded, and its two counter increments can partially succeed; each
  // failure under-counts, and failures accumulate. It is deliberately not
  // retried (INCRBY is not idempotent: a retry after a lost reply would
  // double-count). The log line records the failure — it does not mean the
  // usage was accounted. The paid result is still stored or recoverable.
  try {
    await recordPracticeUsage(audioDurationSec);
  } catch (err) {
    console.error("[practice/evaluate] usage_accounting_failed", JSON.stringify({ attemptId, seq, audioDurationSec }), (err as Error)?.message);
  }

  const stored = toStoredAzureResult(azure);
  if (!stored) {
    const message = "Pronunciation scoring wasn't returned for this recording.";
    await finishAzureFailed(service, claims, "incomplete_result");
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const body: EvaluateAttemptResponse = {
    engine: "azure",
    attemptId,
    seq,
    persisted: false,
    pronScore: azure.pronScore,
    accuracy: azure.accuracy,
    fluency: azure.fluency,
    completeness: azure.completeness,
    prosody: azure.prosody,
    words: azure.words,
    recognizedText: azure.recognizedText,
    rawResult: azure.rawResult,
  };

  const persisted = await persistWithRetry(service, claims, stored);
  if (persisted.kind === "result") {
    const { outcome } = persisted.result;
    log("persist", { attemptId, seq, outcome });
    if (outcome === "applied" || outcome === "already_applied") {
      return NextResponse.json<EvaluateAttemptResponse>({ ...body, persisted: true });
    }
    if (outcome === "superseded") {
      return NextResponse.json<EvaluateAttemptResponse>({ ...body, superseded: true });
    }
    // conflict: a different result is already stored for this seq; it is kept.
    return NextResponse.json<EvaluateAttemptResponse>({ ...body, conflict: true });
  }
  if (persisted.kind === "rejected") {
    log("persist", { attemptId, seq, outcome: "rejected", reason: persisted.reason });
    return NextResponse.json<EvaluateAttemptResponse>(body);
  }
  log("persist", { attemptId, seq, outcome: "unavailable_token_issued" });
  const recoveryToken = issueRecoveryToken(recoverySecret, { ...claims, result: stored });
  return NextResponse.json<EvaluateAttemptResponse>({
    ...body,
    recoveryToken,
    recoveryExpiresAt: new Date(Date.now() + RECOVERY_TOKEN_TTL_SEC * 1000).toISOString(),
  });
}
