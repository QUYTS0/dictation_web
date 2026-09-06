import { azureDictionaryLookup, azureTextTranslate, TranslationError, type SelectionType } from "@/lib/azureTranslator";
import { getCachedTranslation, setCachedTranslation } from "@/lib/translationCache";

export type { TranslationErrorCode } from "@/lib/azureTranslator";
export { TranslationError };

export type TranslationProvider = "azure";

export interface TranslationAlternative {
  text: string;
  partOfSpeech?: string | null;
}

export interface TranslateResult {
  text: string;
  source: TranslationProvider;
  /** Other dictionary senses, most-relevant first — words only. */
  alternatives?: TranslationAlternative[];
}

/** Vocabulary lookups are short selections (a word up to a couple of
 *  sentences), never a whole paragraph — this just guards against a
 *  malformed/oversized request rather than reflecting an Azure limit. */
export const MAX_TRANSLATION_INPUT_LENGTH = 500;

const SOURCE_LANGUAGE = "en";

const LEADING_PUNCTUATION = /^[^\p{L}\p{N}]+/u;
const TRAILING_PUNCTUATION = /[^\p{L}\p{N}]+$/u;

/** Trims leading/trailing punctuation (quotes, commas, periods, etc.) while
 *  preserving apostrophes/hyphens inside a word (e.g. "don't") — those
 *  never reach the string's edges. Local copy of the same rule used to
 *  render clickable words in the transcript (see dictation helpers.ts);
 *  duplicated rather than imported since that file lives under a page
 *  route, not a shared lib. */
function stripEdgePunctuation(text: string): string {
  return text.replace(LEADING_PUNCTUATION, "").replace(TRAILING_PUNCTUATION, "");
}

/**
 * Selection type isn't part of the request contract (callers only know
 * "isWord"), so it's inferred from the text itself — consistently, for
 * every caller, rather than trusting a caller-supplied flag that might
 * disagree with this classification.
 */
export function classifySelectionType(text: string): SelectionType {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return "word";
  const endsWithTerminalPunctuation = /[.!?]["')\]]*$/.test(text.trim());
  if (words.length > 6 || endsWithTerminalPunctuation) return "sentence";
  return "phrase";
}

function normalizeForCache(text: string, selectionType: SelectionType): string {
  const collapsed = text.normalize("NFC").trim().replace(/\s+/g, " ");
  return selectionType === "word" ? stripEdgePunctuation(collapsed).toLowerCase() : collapsed;
}

// Per-server-instance de-dup of identical concurrent lookups (e.g. two
// popovers requesting the same word within the same request burst) so they
// share one Azure round-trip instead of racing independent ones. Best
// effort only — not shared across instances — the Supabase cache above is
// what actually protects the Azure quota across requests/instances.
const inFlightTranslations = new Map<string, Promise<TranslateResult>>();

/**
 * Translates a word, phrase, or sentence to `targetLanguage` via Azure
 * Translator, using the shared Supabase cache to avoid spending quota on
 * repeat lookups. Always throws a typed TranslationError on failure —
 * callers that must never block on translation (e.g. saving a vocabulary
 * item) should catch and treat any error as "no translation available",
 * exactly as before.
 */
export async function translateText(rawText: string, targetLanguage: string): Promise<TranslateResult> {
  const text = rawText.trim();
  if (!text) {
    throw new TranslationError("TRANSLATION_INVALID_INPUT", "Nothing to translate.");
  }
  if (text.length > MAX_TRANSLATION_INPUT_LENGTH) {
    throw new TranslationError(
      "TRANSLATION_INVALID_INPUT",
      `Selection is too long to translate (max ${MAX_TRANSLATION_INPUT_LENGTH} characters).`
    );
  }

  const selectionType = classifySelectionType(text);
  const normalizedText = normalizeForCache(text, selectionType);
  const dedupeKey = `${SOURCE_LANGUAGE}:${targetLanguage}:${selectionType}:${normalizedText}`;

  const existing = inFlightTranslations.get(dedupeKey);
  if (existing) return existing;

  const promise = performTranslation(text, selectionType, targetLanguage, normalizedText);
  inFlightTranslations.set(dedupeKey, promise);
  try {
    return await promise;
  } finally {
    inFlightTranslations.delete(dedupeKey);
  }
}

async function performTranslation(
  text: string,
  selectionType: SelectionType,
  targetLanguage: string,
  normalizedText: string
): Promise<TranslateResult> {
  const cached = await getCachedTranslation({
    sourceLanguage: SOURCE_LANGUAGE,
    targetLanguage,
    selectionType,
    normalizedText,
  });
  if (cached) {
    return {
      text: cached.translation,
      source: "azure",
      alternatives: cached.metadata?.alternatives,
    };
  }

  const result =
    selectionType === "word"
      ? await translateWord(text, targetLanguage)
      : await translatePhraseOrSentence(text, targetLanguage);

  // Never cache empty/failed results — only reached on success, but guard
  // anyway in case a provider ever returns a blank string as "success".
  if (result.text.trim()) {
    await setCachedTranslation({
      sourceLanguage: SOURCE_LANGUAGE,
      targetLanguage,
      selectionType,
      normalizedText,
      translation: result.text,
      metadata: result.alternatives ? { alternatives: result.alternatives } : undefined,
    });
  }

  return result;
}

async function translateWord(word: string, targetLanguage: string): Promise<TranslateResult> {
  const cleaned = stripEdgePunctuation(word).trim() || word;

  const dictionary = await azureDictionaryLookup(cleaned, SOURCE_LANGUAGE, targetLanguage);
  const [best, ...rest] = dictionary.translations;

  if (best) {
    return {
      text: best.displayTarget,
      source: "azure",
      alternatives: rest.length > 0 ? rest.map((t) => ({ text: t.displayTarget, partOfSpeech: t.posTag ?? null })) : undefined,
    };
  }

  // Azure-to-Azure fallback: Dictionary Lookup found nothing usable (e.g. a
  // rare word, typo, or name it has no dictionary entry for) — fall back to
  // full Text Translation instead of another provider.
  return translatePhraseOrSentence(cleaned, targetLanguage);
}

async function translatePhraseOrSentence(text: string, targetLanguage: string): Promise<TranslateResult> {
  const { text: translated } = await azureTextTranslate(text, SOURCE_LANGUAGE, targetLanguage);
  return { text: translated, source: "azure" };
}
