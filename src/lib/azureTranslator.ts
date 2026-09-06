// Azure Translator (F0 free tier) — Dictionary Lookup and Text Translation
// for the vocabulary word/phrase/sentence lookup path only. Server-side
// only: the key never reaches the client bundle, matching the discipline
// already established for GEMINI_API_KEY/AZURE_SPEECH_KEY. Do not use this
// for transcript translation — that pipeline stays on its own tiers
// (YouTube captions → free library → Gemini), untouched by this migration.

export type SelectionType = "word" | "phrase" | "sentence";

export type TranslationErrorCode =
  | "TRANSLATION_CONFIG_ERROR"
  | "TRANSLATION_AUTH_ERROR"
  | "TRANSLATION_RATE_LIMITED"
  | "TRANSLATION_TIMEOUT"
  | "TRANSLATION_INVALID_RESPONSE"
  | "TRANSLATION_SERVICE_ERROR"
  | "TRANSLATION_INVALID_INPUT";

export class TranslationError extends Error {
  code: TranslationErrorCode;
  status?: number;
  /** Seconds to wait before retrying, from Azure's Retry-After header (429s only). */
  retryAfterSec?: number;

  constructor(code: TranslationErrorCode, message: string, status?: number, retryAfterSec?: number) {
    super(message);
    this.name = "TranslationError";
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

const REQUEST_TIMEOUT_MS = 8_000;
// One retry, and only for failures that are plausibly transient (network
// error, timeout-free 5xx). Never retries 429 (rate limit/quota) — a quota
// that's actually exhausted must not be hammered again a few hundred ms
// later, and Retry-After on a real F0 rate limit is usually far longer than
// a request-scoped retry could reasonably wait for anyway.
const MAX_TRANSIENT_RETRIES = 1;
const RETRY_BACKOFF_MS = 400;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isAzureTranslatorConfigured(): boolean {
  return !!(
    process.env.AZURE_TRANSLATOR_KEY &&
    process.env.AZURE_TRANSLATOR_REGION &&
    process.env.AZURE_TRANSLATOR_ENDPOINT
  );
}

function getConfig(): { key: string; region: string; endpoint: string } {
  const key = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;
  const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT;
  if (!key || !region || !endpoint) {
    throw new TranslationError(
      "TRANSLATION_CONFIG_ERROR",
      "Translation is not configured on the server. Set AZURE_TRANSLATOR_KEY, AZURE_TRANSLATOR_REGION and AZURE_TRANSLATOR_ENDPOINT."
    );
  }
  return { key, region, endpoint: endpoint.replace(/\/+$/, "") };
}

/**
 * POSTs to an Azure Translator REST endpoint and returns the parsed JSON
 * body. Never logs the API key or Authorization/Ocp-Apim-Subscription-Key
 * headers — only the response status and a truncated body snippet on
 * failure, for diagnosability without leaking credentials.
 */
async function azureFetch(path: string, body: unknown, attempt = 0): Promise<unknown> {
  const { key, region, endpoint } = getConfig();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Ocp-Apim-Subscription-Region": region,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    if (timedOut) {
      throw new TranslationError("TRANSLATION_TIMEOUT", "Translation request timed out.");
    }
    if (attempt < MAX_TRANSIENT_RETRIES) {
      await delay(RETRY_BACKOFF_MS);
      return azureFetch(path, body, attempt + 1);
    }
    throw new TranslationError("TRANSLATION_SERVICE_ERROR", "Could not reach the translation service.");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new TranslationError(
      "TRANSLATION_AUTH_ERROR",
      "Translation service rejected the request credentials.",
      response.status
    );
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    throw new TranslationError(
      "TRANSLATION_RATE_LIMITED",
      "Translation is temporarily unavailable. Please try again later.",
      429,
      Number.isFinite(retryAfterSec) ? retryAfterSec : undefined
    );
  }

  if (response.status >= 500) {
    if (attempt < MAX_TRANSIENT_RETRIES) {
      await delay(RETRY_BACKOFF_MS);
      return azureFetch(path, body, attempt + 1);
    }
    throw new TranslationError(
      "TRANSLATION_SERVICE_ERROR",
      "Translation service is temporarily unavailable.",
      response.status
    );
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    console.error(`[azureTranslator] request failed (${response.status}):`, bodyText.slice(0, 300));
    throw new TranslationError(
      "TRANSLATION_INVALID_RESPONSE",
      `Translation request failed (${response.status}).`,
      response.status
    );
  }

  try {
    return await response.json();
  } catch {
    throw new TranslationError("TRANSLATION_INVALID_RESPONSE", "Translation service returned an unreadable response.");
  }
}

export interface AzureDictionaryTranslation {
  normalizedTarget: string;
  displayTarget: string;
  posTag?: string;
  confidence?: number;
}

export interface AzureDictionaryLookupResult {
  normalizedSource: string;
  /** Sorted by confidence, highest first — [0] is the most relevant translation. */
  translations: AzureDictionaryTranslation[];
}

/** https://api.cognitive.microsofttranslator.com/dictionary/lookup */
export async function azureDictionaryLookup(
  text: string,
  from: string,
  to: string
): Promise<AzureDictionaryLookupResult> {
  const json = await azureFetch(`/dictionary/lookup?api-version=3.0&from=${from}&to=${to}`, [{ Text: text }]);

  if (!Array.isArray(json) || !json[0] || typeof json[0] !== "object") {
    throw new TranslationError("TRANSLATION_INVALID_RESPONSE", "Unexpected dictionary lookup response shape.");
  }

  const entry = json[0] as { normalizedSource?: unknown; translations?: unknown };
  const rawTranslations = Array.isArray(entry.translations) ? entry.translations : [];

  const translations: AzureDictionaryTranslation[] = rawTranslations
    .map((raw): AzureDictionaryTranslation | null => {
      const t = raw as Record<string, unknown>;
      const normalizedTarget = typeof t.normalizedTarget === "string" ? t.normalizedTarget : undefined;
      const displayTarget = typeof t.displayTarget === "string" ? t.displayTarget : normalizedTarget;
      if (!normalizedTarget || !displayTarget) return null;
      return {
        normalizedTarget,
        displayTarget,
        posTag: typeof t.posTag === "string" ? t.posTag : undefined,
        confidence: typeof t.confidence === "number" ? t.confidence : undefined,
      };
    })
    .filter((t): t is AzureDictionaryTranslation => t !== null)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

  return {
    normalizedSource: typeof entry.normalizedSource === "string" ? entry.normalizedSource : text,
    translations,
  };
}

export interface AzureTranslateResult {
  text: string;
}

/** https://api.cognitive.microsofttranslator.com/translate */
export async function azureTextTranslate(text: string, from: string, to: string): Promise<AzureTranslateResult> {
  const json = await azureFetch(`/translate?api-version=3.0&from=${from}&to=${to}`, [{ Text: text }]);

  if (!Array.isArray(json) || !json[0] || typeof json[0] !== "object") {
    throw new TranslationError("TRANSLATION_INVALID_RESPONSE", "Unexpected translation response shape.");
  }

  const entry = json[0] as { translations?: unknown };
  const first = Array.isArray(entry.translations) ? (entry.translations[0] as Record<string, unknown>) : undefined;
  const translated = first && typeof first.text === "string" ? first.text : undefined;

  if (!translated) {
    throw new TranslationError("TRANSLATION_INVALID_RESPONSE", "Translation service returned no result.");
  }

  return { text: translated };
}
