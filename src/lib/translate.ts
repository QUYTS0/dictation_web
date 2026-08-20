import { translate } from "@vitalets/google-translate-api";

export type TranslationSource = "free_library";

export interface TranslateResult {
  text: string;
  source: TranslationSource;
}

export class TranslationUnavailableError extends Error {
  constructor() {
    super("Translation attempt failed");
    this.name = "TranslationUnavailableError";
  }
}

/**
 * Best-effort translation for short, standalone text (a word, phrase, or
 * sentence) — not tied to a cached transcript. Uses the free, no-API-key
 * library only; Gemini was removed from this path (2026-08) because it was
 * the worst-value consumer of a very small free-tier Gemini budget (up to 2
 * calls per single-word lookup, never cached) — see transcript translation
 * and /api/ai/explain for where Gemini is actually worth spending it.
 *
 * By default never throws: callers should treat a null result as
 * "translation unavailable" and continue without blocking on it (this is
 * what the vocabulary-save route relies on — a translation hiccup must never
 * block saving the word itself). Pass `throwOnFailure: true` to instead
 * throw TranslationUnavailableError when the attempt errored out (as opposed
 * to a clean run that just found nothing) — used by the preview route so it
 * can tell the client "this failed, try again" instead of silently returning
 * an empty result indistinguishable from "no translation exists".
 */
export async function translateText(
  text: string,
  language: string,
  { throwOnFailure = false }: { throwOnFailure?: boolean } = {}
): Promise<TranslateResult | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const { text: translated } = await translate(trimmed, { to: language });
    if (translated) return { text: translated, source: "free_library" };
  } catch (err) {
    console.warn(
      "[translate] free translation library failed:",
      err instanceof Error ? err.message : err
    );
    if (throwOnFailure) throw new TranslationUnavailableError();
  }

  return null;
}
