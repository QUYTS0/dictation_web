// Azure AI Language — Key Phrase Extraction. Optional topic-phrase
// enrichment only, never a CEFR/difficulty engine. Mirrors
// src/lib/azureTranslator.ts's azureFetch pattern exactly: AbortController
// timeout, one transient retry (network/5xx only, never 429), never logs
// keys/headers. Server-side only.
import { AZURE_KEY_PHRASE } from "./config";

export type KeyPhraseErrorCode =
  | "KEY_PHRASE_CONFIG_ERROR"
  | "KEY_PHRASE_AUTH_ERROR"
  | "KEY_PHRASE_RATE_LIMITED"
  | "KEY_PHRASE_TIMEOUT"
  | "KEY_PHRASE_INVALID_RESPONSE"
  | "KEY_PHRASE_SERVICE_ERROR";

export class KeyPhraseError extends Error {
  code: KeyPhraseErrorCode;
  status?: number;
  retryAfterSec?: number;

  constructor(code: KeyPhraseErrorCode, message: string, status?: number, retryAfterSec?: number) {
    super(message);
    this.name = "KeyPhraseError";
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isAzureKeyPhraseConfigured(): boolean {
  return !!(process.env.AZURE_LANGUAGE_KEY && process.env.AZURE_LANGUAGE_ENDPOINT);
}

function getConfig(): { key: string; endpoint: string } {
  const key = process.env.AZURE_LANGUAGE_KEY;
  const endpoint = process.env.AZURE_LANGUAGE_ENDPOINT;
  if (!key || !endpoint) {
    throw new KeyPhraseError(
      "KEY_PHRASE_CONFIG_ERROR",
      "Azure Key Phrase Extraction is not configured. Set AZURE_LANGUAGE_KEY and AZURE_LANGUAGE_ENDPOINT."
    );
  }
  return { key, endpoint: endpoint.replace(/\/+$/, "") };
}

export interface KeyPhraseDocumentInput {
  id: string;
  text: string;
}

interface AnalyzeTextResponse {
  results?: {
    documents?: Array<{ id: string; keyPhrases?: string[] }>;
    errors?: Array<{ id: string }>;
  };
}

async function azureFetch(documents: KeyPhraseDocumentInput[], attempt = 0): Promise<AnalyzeTextResponse> {
  const { key, endpoint } = getConfig();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AZURE_KEY_PHRASE.REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${endpoint}/language/:analyze-text?api-version=${AZURE_KEY_PHRASE.API_VERSION}`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "KeyPhraseExtraction",
        analysisInput: {
          documents: documents.map((d) => ({ id: d.id, language: "en", text: d.text })),
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    if (timedOut) {
      throw new KeyPhraseError("KEY_PHRASE_TIMEOUT", "Key Phrase Extraction request timed out.");
    }
    if (attempt < AZURE_KEY_PHRASE.MAX_TRANSIENT_RETRIES) {
      await delay(AZURE_KEY_PHRASE.RETRY_BACKOFF_MS);
      return azureFetch(documents, attempt + 1);
    }
    throw new KeyPhraseError("KEY_PHRASE_SERVICE_ERROR", "Could not reach the Key Phrase Extraction service.");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new KeyPhraseError("KEY_PHRASE_AUTH_ERROR", "Azure rejected the request credentials.", response.status);
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    throw new KeyPhraseError(
      "KEY_PHRASE_RATE_LIMITED",
      "Key Phrase Extraction is temporarily unavailable.",
      429,
      Number.isFinite(retryAfterSec) ? retryAfterSec : undefined
    );
  }

  if (response.status >= 500) {
    if (attempt < AZURE_KEY_PHRASE.MAX_TRANSIENT_RETRIES) {
      await delay(AZURE_KEY_PHRASE.RETRY_BACKOFF_MS);
      return azureFetch(documents, attempt + 1);
    }
    throw new KeyPhraseError("KEY_PHRASE_SERVICE_ERROR", "Key Phrase Extraction is temporarily unavailable.", response.status);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    console.error(`[azureKeyPhrase] request failed (${response.status}):`, bodyText.slice(0, 300));
    throw new KeyPhraseError("KEY_PHRASE_INVALID_RESPONSE", `Key Phrase Extraction request failed (${response.status}).`, response.status);
  }

  try {
    return (await response.json()) as AnalyzeTextResponse;
  } catch {
    throw new KeyPhraseError("KEY_PHRASE_INVALID_RESPONSE", "Key Phrase Extraction returned an unreadable response.");
  }
}

/** One HTTP call covering up to AZURE_KEY_PHRASE.MAX_DOCUMENTS_PER_REQUEST
 *  documents (chunking is the caller's responsibility — see pipeline.ts).
 *  Returns a map of document id -> key phrases; a document Azure reports an
 *  error for is simply absent from the returned map. */
export async function fetchKeyPhrasesForDocuments(documents: KeyPhraseDocumentInput[]): Promise<Map<string, string[]>> {
  const response = await azureFetch(documents);
  const result = new Map<string, string[]>();
  for (const doc of response.results?.documents ?? []) {
    result.set(doc.id, doc.keyPhrases ?? []);
  }
  return result;
}
