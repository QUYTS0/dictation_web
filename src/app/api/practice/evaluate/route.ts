import { NextRequest, NextResponse } from "next/server";
import { assessPronunciation, isAzureSpeechConfigured, AzureSpeechError } from "@/lib/azureSpeech";
import { reservePracticeQuota, recordPracticeUsage } from "@/lib/practiceQuota";
import { checkRateLimit } from "@/lib/rateLimit";

// 16kHz mono 16-bit PCM WAV runs ~32KB/sec; the recorder caps takes at 20s
// (see useAudioRecorder's maxDurationSec), so a genuine take never exceeds
// ~640KB. This just guards against a malformed/oversized upload.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/**
 * Temporary evaluation flow (see "Shadowing and Pronunciation Practice
 * Plan.md" §8): the client sends the in-memory recording (already converted
 * to 16kHz mono WAV — see lib/utils/wavEncode.ts) as multipart form-data,
 * this route calls Azure Pronunciation Assessment, and returns structured
 * JSON only. The audio is never written to disk or any store — it lives
 * only in the request body and the Buffer passed to Azure, both freed once
 * this handler returns.
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "practice/evaluate", { limit: 10, windowMs: 60_000 });
  if (rateLimitResponse) return rateLimitResponse;

  if (!isAzureSpeechConfigured()) {
    return NextResponse.json({ error: "Evaluation engine not configured." }, { status: 503 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const audio = formData.get("audio");
  const referenceText = formData.get("referenceText");
  const durationSecRaw = formData.get("durationSec");

  if (
    !(audio instanceof Blob) ||
    typeof referenceText !== "string" ||
    !referenceText.trim() ||
    typeof durationSecRaw !== "string"
  ) {
    return NextResponse.json({ error: "audio, referenceText, and durationSec are required." }, { status: 400 });
  }

  const durationSec = Number(durationSecRaw);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return NextResponse.json({ error: "Invalid durationSec." }, { status: 400 });
  }

  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Recording is too large to evaluate." }, { status: 413 });
  }

  const reservation = await reservePracticeQuota(durationSec);
  if (!reservation.allowed) {
    return NextResponse.json(
      { error: "quota-exceeded", message: "Monthly free evaluation limit reached." },
      { status: 429 }
    );
  }

  try {
    const wavBuffer = Buffer.from(await audio.arrayBuffer());
    const result = await assessPronunciation({ wavBuffer, referenceText });
    await recordPracticeUsage(durationSec);
    return NextResponse.json({ engine: "azure" as const, ...result });
  } catch (err) {
    console.error("[practice/evaluate] Azure Speech error:", err);
    const message = err instanceof AzureSpeechError ? err.message : "Evaluation failed. Please try again.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
