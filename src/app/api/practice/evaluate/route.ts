import { NextRequest, NextResponse } from "next/server";
import { assessPronunciation, isAzureSpeechConfigured, AzureSpeechError } from "@/lib/azureSpeech";
import { reservePracticeQuota, recordPracticeUsage } from "@/lib/practiceQuota";
import { checkRateLimit } from "@/lib/rateLimit";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mapPracticeEvaluationError } from "@/lib/supabase/practiceEvaluationErrors";
import { isUuid } from "@/lib/practice/validation";
import { getRecoverySecret, issueRecoveryToken, RECOVERY_TOKEN_TTL_SEC } from "@/lib/practice/recoveryToken";
import { finishAzureFailed, persistWithRetry, toStoredAzureResult } from "@/lib/practice/azureEvaluation";
import type { EvaluateAttemptResponse } from "@/lib/practice/shadowingTypes";

// 16kHz mono 16-bit PCM WAV runs ~32KB/sec; the recorder caps takes at 20s
// (see useAudioRecorder's maxDurationSec), so a genuine take never exceeds
// ~640KB. This just guards against a malformed/oversized upload.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

interface BeginResult {
  attemptId: string;
  seq: number;
  referenceText: string;
  recordingDurationSec: number;
}

/**
 * Attempt-scoped Azure Pronunciation Assessment (plan §9.4). An explicit
 * user action on an already-SAVED recording:
 *   request: multipart { attemptId, audio } — no reference text, no scores;
 *   1. configuration (Azure + recovery signing secret) is checked before
 *      anything is spent;
 *   2. the caller is authenticated (GoTrue) and fn_begin_azure_evaluation
 *      re-checks ownership + relationships, resolves the reference text from
 *      the attempt's pinned sentence and admits the request (seq + pending);
 *   3. Azure is called with the audio (never stored anywhere);
 *   4. the result is written for (attempt, user, seq) only — a newer
 *      request for the same attempt supersedes this one; a database failure
 *      after a paid result yields persisted:false plus a server-signed
 *      recovery token instead of losing the result.
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
    return NextResponse.json({ error: "Recording is too large to evaluate." }, { status: 413 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const service = createServiceClient();
  const { data: begun, error: beginError } = await service.rpc("fn_begin_azure_evaluation", {
    p_attempt_id: attemptId,
    p_user_id: user.id,
  });
  if (beginError || !begun) return mapPracticeEvaluationError(beginError, "Failed to start the evaluation.");
  const { seq, referenceText, recordingDurationSec } = begun as BeginResult;
  const claims = { attemptId, userId: user.id, seq };

  // Quota is charged by the stored recording duration, not a client number.
  const reservation = await reservePracticeQuota(Number(recordingDurationSec));
  if (!reservation.allowed) {
    await finishAzureFailed(service, claims, "quota_exceeded");
    return NextResponse.json(
      { error: "quota-exceeded", message: "Monthly free evaluation limit reached." },
      { status: 429 }
    );
  }

  let azure;
  try {
    const wavBuffer = Buffer.from(await audio.arrayBuffer());
    azure = await assessPronunciation({ wavBuffer, referenceText });
  } catch (err) {
    console.error("[practice/evaluate] Azure Speech error:", err instanceof Error ? err.message : err);
    const message = err instanceof AzureSpeechError ? err.message : "Evaluation failed. Please try again.";
    // Practice credit is untouched: only this attempt's evaluation fails.
    await finishAzureFailed(service, claims, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
  await recordPracticeUsage(Number(recordingDurationSec));

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
    if (outcome === "applied" || outcome === "already_applied") {
      return NextResponse.json<EvaluateAttemptResponse>({ ...body, persisted: true });
    }
    // superseded / conflict: a newer request owns this attempt's result.
    console.log(`[practice/evaluate] attempt=${attemptId} seq=${seq} not stored (${outcome})`);
    return NextResponse.json<EvaluateAttemptResponse>({ ...body, superseded: true });
  }
  if (persisted.kind === "rejected") {
    return NextResponse.json<EvaluateAttemptResponse>(body);
  }
  const recoveryToken = issueRecoveryToken(recoverySecret, { ...claims, result: stored });
  return NextResponse.json<EvaluateAttemptResponse>({
    ...body,
    recoveryToken,
    recoveryExpiresAt: new Date(Date.now() + RECOVERY_TOKEN_TTL_SEC * 1000).toISOString(),
  });
}
