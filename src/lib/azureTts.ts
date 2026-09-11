// Azure AI Speech — Text-to-Speech (TTS). Reuses the same AZURE_SPEECH_KEY/
// AZURE_SPEECH_REGION resource as pronunciation assessment (see
// azureSpeech.ts) — F0 Speech resources meter STT and TTS as separate
// pools on the same resource. Server-side only — the key never reaches the
// client bundle. This module only knows how to talk to Azure; caching and
// Storage upload live in vocabularyAudioCache.ts.

import type { TtsErrorCode } from "@/lib/types";

const REQUEST_TIMEOUT_MS = 10_000;

// Exactly one voice/locale/format, hardcoded server-side — never
// client-selectable. en-US-JennyNeural is a GA, standard (non-HD,
// non-custom) neural voice.
export const DEFAULT_TTS_VOICE = "en-US-JennyNeural";
export const DEFAULT_TTS_LOCALE = "en-US";
export const DEFAULT_TTS_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
// Bump to force fresh synthesis for every future lookup — old cache rows
// simply stop matching the new version's cache key and are never reused,
// no migration needed (see vocabularyAudioCache.ts).
export const TTS_SYNTHESIS_VERSION = "v1";

export function isAzureTtsConfigured(): boolean {
  return !!(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
}

export class AzureTtsError extends Error {
  status?: number;
  code: TtsErrorCode;
  constructor(message: string, code: TtsErrorCode, status?: number) {
    super(message);
    this.name = "AzureTtsError";
    this.code = code;
    this.status = status;
  }
}

function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Standard (non-custom) voices require SSML, not plain text — the server
 *  always builds this itself from escaped plain text; client-supplied
 *  markup is never accepted. */
function buildSsml(text: string, voice: string, locale: string): string {
  return `<speak version='1.0' xml:lang='${locale}'><voice name='${voice}'>${escapeSsml(text)}</voice></speak>`;
}

export interface SynthesizeSpeechParams {
  text: string;
  voice?: string;
  locale?: string;
  outputFormat?: string;
}

export interface SynthesizeSpeechResult {
  audio: Buffer;
  contentType: string;
}

/**
 * Calls Azure's REST TTS endpoint (https://{region}.tts.speech.microsoft.com/
 * cognitiveservices/v1) and returns the raw audio bytes. Never throws a
 * plain Error — always AzureTtsError with a stable `code` so callers (the
 * pronounce route) can map failures to a typed client response without
 * string-matching.
 */
export async function synthesizeSpeech(params: SynthesizeSpeechParams): Promise<SynthesizeSpeechResult> {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    throw new AzureTtsError("Azure Speech is not configured.", "TTS_NOT_CONFIGURED");
  }

  const voice = params.voice ?? DEFAULT_TTS_VOICE;
  const locale = params.locale ?? DEFAULT_TTS_LOCALE;
  const outputFormat = params.outputFormat ?? DEFAULT_TTS_OUTPUT_FORMAT;
  const ssml = buildSsml(params.text, voice, locale);
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": outputFormat,
        "User-Agent": "dictation-web-tts",
      },
      body: ssml,
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    throw new AzureTtsError(
      timedOut ? "Speech synthesis request timed out." : "Could not reach the speech synthesis service.",
      "TTS_UPSTREAM_ERROR"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    console.error(`[azureTts] request failed (${response.status}):`, bodyText.slice(0, 300));
    throw new AzureTtsError(`Speech synthesis request failed (${response.status}).`, "TTS_UPSTREAM_ERROR", response.status);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("audio")) {
    throw new AzureTtsError("Speech synthesis returned an unexpected response.", "TTS_UPSTREAM_ERROR");
  }

  const arrayBuffer = await response.arrayBuffer();
  const audio = Buffer.from(arrayBuffer);
  // A real synthesized clip for even a short word/phrase is comfortably
  // above a trivial handful of bytes — reject an implausibly short body
  // before it can ever become a cache entry (see vocabularyAudioCache.ts).
  if (audio.byteLength < 256) {
    throw new AzureTtsError("Speech synthesis returned an empty response.", "TTS_UPSTREAM_ERROR");
  }

  return { audio, contentType };
}
