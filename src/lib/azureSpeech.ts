// Azure AI Speech — Pronunciation Assessment (F0 free tier). Server-side
// only — the key never reaches the client bundle, matching the discipline
// already established for GEMINI_API_KEY/SUPABASE_SERVICE_ROLE_KEY. See
// "Shadowing and Pronunciation Practice Plan.md" §8/§9.

const DEFAULT_LANGUAGE = "en-US";
const REQUEST_TIMEOUT_MS = 15_000;

export function isAzureSpeechConfigured(): boolean {
  return !!(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
}

export class AzureSpeechError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AzureSpeechError";
    this.status = status;
  }
}

export interface AzurePronunciationWord {
  word: string;
  accuracyScore: number | null;
  errorType: string;
}

export interface AzurePronunciationResult {
  accuracy: number | null;
  fluency: number | null;
  completeness: number | null;
  prosody: number | null;
  words: AzurePronunciationWord[];
  recognizedText: string;
}

// Shape of the fields this code reads from Azure's short-audio recognition
// response (`format=detailed`) — not the full documented schema, just what's
// consumed below.
interface AzureWordResult {
  Word: string;
  PronunciationAssessment?: { AccuracyScore?: number; ErrorType?: string };
}
interface AzureNBestResult {
  Display?: string;
  PronunciationAssessment?: {
    AccuracyScore?: number;
    FluencyScore?: number;
    CompletenessScore?: number;
    ProsodyScore?: number;
  };
  Words?: AzureWordResult[];
}
interface AzureRecognitionResponse {
  RecognitionStatus?: string;
  DisplayText?: string;
  NBest?: AzureNBestResult[];
}

/**
 * Calls Azure's short-audio Pronunciation Assessment REST endpoint. Expects
 * 16kHz mono 16-bit PCM WAV — the only format reliably accepted without a
 * GStreamer-enabled Speech SDK host (not available in a Vercel function), so
 * the browser's webm/mp4 recording must be converted client-side first (see
 * lib/utils/wavEncode.ts) before this ever runs.
 */
export async function assessPronunciation(params: {
  wavBuffer: Buffer;
  referenceText: string;
  language?: string;
}): Promise<AzurePronunciationResult> {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    throw new AzureSpeechError("Azure Speech is not configured.");
  }

  const language = params.language ?? DEFAULT_LANGUAGE;
  const assessmentConfig = {
    ReferenceText: params.referenceText,
    GradingSystem: "HundredMark",
    Granularity: "Phoneme",
    Dimension: "Comprehensive",
    EnableMiscue: true,
    EnableProsodyAssessment: true,
  };
  const pronunciationHeader = Buffer.from(JSON.stringify(assessmentConfig)).toString("base64");
  const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=detailed`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
        Accept: "application/json",
        "Pronunciation-Assessment": pronunciationHeader,
      },
      body: new Uint8Array(params.wavBuffer),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    throw new AzureSpeechError(timedOut ? "Evaluation request timed out." : "Could not reach the evaluation engine.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    console.error(`[azureSpeech] request failed (${response.status}):`, bodyText.slice(0, 300));
    throw new AzureSpeechError(`Evaluation engine request failed (${response.status}).`, response.status);
  }

  const json = (await response.json()) as AzureRecognitionResponse;

  if (json.RecognitionStatus && json.RecognitionStatus !== "Success") {
    if (json.RecognitionStatus === "NoMatch") {
      return { accuracy: null, fluency: null, completeness: null, prosody: null, words: [], recognizedText: "" };
    }
    throw new AzureSpeechError(`Evaluation engine could not process this recording (${json.RecognitionStatus}).`);
  }

  const nbest = json.NBest?.[0];
  const pa = nbest?.PronunciationAssessment;
  const words: AzurePronunciationWord[] = (nbest?.Words ?? []).map((w) => ({
    word: w.Word,
    accuracyScore: w.PronunciationAssessment?.AccuracyScore ?? null,
    errorType: w.PronunciationAssessment?.ErrorType ?? "None",
  }));

  return {
    accuracy: pa?.AccuracyScore ?? null,
    fluency: pa?.FluencyScore ?? null,
    completeness: pa?.CompletenessScore ?? null,
    prosody: pa?.ProsodyScore ?? null,
    words,
    recognizedText: json.DisplayText ?? nbest?.Display ?? "",
  };
}
