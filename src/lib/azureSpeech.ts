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
  /** Machine-readable reason, set for cases callers/tests may want to
   *  distinguish from the human-readable `message` (e.g. quota logic,
   *  regression tests) without string-matching prose. */
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "AzureSpeechError";
    this.status = status;
    this.code = code;
  }
}

export interface AzurePronunciationSyllable {
  syllable: string;
  accuracyScore: number | null;
}

export interface AzurePronunciationPhoneme {
  phoneme: string;
  accuracyScore: number | null;
}

export interface AzurePronunciationWord {
  word: string;
  accuracyScore: number | null;
  errorType: string;
  offset?: number;
  duration?: number;
  syllables?: AzurePronunciationSyllable[];
  phonemes?: AzurePronunciationPhoneme[];
}

export interface AzurePronunciationResult {
  /** Azure's overall PronScore — the headline "Pronunciation Score". Not a
   *  blend computed here; used as-is. */
  pronScore: number | null;
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
//
// Azure has been observed returning pronunciation assessment scores in two
// different shapes for the same REST endpoint: nested under a
// `PronunciationAssessment` object (the shape Microsoft's own docs show), and
// flat, directly on the `NBest[]`/word/syllable/phoneme entry itself. Every
// interface below declares both so a real response is never misread as
// "missing" just because it used the other shape.
interface AzureUtteranceAssessmentFields {
  PronScore?: number;
  AccuracyScore?: number;
  FluencyScore?: number;
  CompletenessScore?: number;
  ProsodyScore?: number;
}
interface AzureWordAssessmentFields {
  AccuracyScore?: number;
  ErrorType?: string;
}
interface AzureSyllableResult {
  Syllable: string;
  AccuracyScore?: number;
  PronunciationAssessment?: { AccuracyScore?: number };
}
interface AzurePhonemeResult {
  Phoneme: string;
  AccuracyScore?: number;
  PronunciationAssessment?: { AccuracyScore?: number };
}
interface AzureWordResult extends AzureWordAssessmentFields {
  Word: string;
  Offset?: number;
  Duration?: number;
  PronunciationAssessment?: AzureWordAssessmentFields;
  Syllables?: AzureSyllableResult[];
  Phonemes?: AzurePhonemeResult[];
}
interface AzureNBestResult extends AzureUtteranceAssessmentFields {
  Display?: string;
  PronunciationAssessment?: AzureUtteranceAssessmentFields;
  Words?: AzureWordResult[];
}
interface AzureRecognitionResponse {
  RecognitionStatus?: string;
  DisplayText?: string;
  NBest?: AzureNBestResult[];
}

/** Returns the first argument that is an actual finite number — deliberately
 *  not a truthiness/`??` chain, since `0` is a valid score and must not be
 *  skipped in favor of a later fallback. */
function firstFiniteNumber(...values: Array<number | undefined>): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
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
      // Azure understood the request but couldn't recognize any speech in
      // the audio at all — surfacing this as a normal empty "result" used to
      // render as a blank success card. Treat it as a failure instead so the
      // UI can show an actionable reason and a Retry action.
      throw new AzureSpeechError("No speech was recognized in this recording. Try recording again.");
    }
    throw new AzureSpeechError(`Evaluation engine could not process this recording (${json.RecognitionStatus}).`);
  }

  const nbest = json.NBest?.[0];
  // Nested shape wins when both are present (matches Microsoft's documented
  // schema); flat fields on NBest itself are the fallback some responses use
  // instead. See the AzureUtteranceAssessmentFields comment above.
  const paNested = nbest?.PronunciationAssessment;
  const pronScore = firstFiniteNumber(paNested?.PronScore, nbest?.PronScore);
  const accuracy = firstFiniteNumber(paNested?.AccuracyScore, nbest?.AccuracyScore);
  const fluency = firstFiniteNumber(paNested?.FluencyScore, nbest?.FluencyScore);
  const completeness = firstFiniteNumber(paNested?.CompletenessScore, nbest?.CompletenessScore);
  const prosody = firstFiniteNumber(paNested?.ProsodyScore, nbest?.ProsodyScore);

  const hasAnyAssessmentScore = [pronScore, accuracy, fluency, completeness, prosody].some((v) => v !== null);
  if (!hasAnyAssessmentScore) {
    // RecognitionStatus was "Success" (speech was transcribed) but neither
    // the nested nor the flat shape carried a single numeric assessment
    // score — the assessment itself failed even though plain recognition
    // succeeded. This is distinct from one *metric* being unavailable (e.g.
    // Prosody on some tiers), which still returns normally below with just
    // that field as null. Logged (without audio) so a persistent report is
    // diagnosable from server logs.
    console.error(
      "[azureSpeech] Success but no pronunciation assessment score in response (checked nested and flat shapes):",
      JSON.stringify(json).slice(0, 500)
    );
    throw new AzureSpeechError(
      "Pronunciation scoring wasn't returned for this recording. Please try again.",
      undefined,
      "PRONUNCIATION_ASSESSMENT_MISSING"
    );
  }

  const words: AzurePronunciationWord[] = (nbest?.Words ?? []).map((w) => ({
    word: w.Word,
    accuracyScore: firstFiniteNumber(w.PronunciationAssessment?.AccuracyScore, w.AccuracyScore),
    errorType: w.PronunciationAssessment?.ErrorType ?? w.ErrorType ?? "None",
    offset: w.Offset,
    duration: w.Duration,
    syllables: w.Syllables?.map((s) => ({
      syllable: s.Syllable,
      accuracyScore: firstFiniteNumber(s.PronunciationAssessment?.AccuracyScore, s.AccuracyScore),
    })),
    phonemes: w.Phonemes?.map((p) => ({
      phoneme: p.Phoneme,
      accuracyScore: firstFiniteNumber(p.PronunciationAssessment?.AccuracyScore, p.AccuracyScore),
    })),
  }));

  return {
    pronScore,
    accuracy,
    fluency,
    completeness,
    prosody,
    words,
    recognizedText: json.DisplayText ?? nbest?.Display ?? "",
  };
}
