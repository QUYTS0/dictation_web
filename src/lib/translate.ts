import { translate } from "@vitalets/google-translate-api";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_MODEL_NAME } from "@/lib/gemini";

const GEMINI_TIMEOUT_MS = 4_000;

export type TranslationSource = "free_library" | "gemini";

export interface TranslateResult {
  text: string;
  source: TranslationSource;
}

/**
 * Best-effort translation for short, standalone text (a word, phrase, or
 * sentence) — not tied to a cached transcript. Tries the free, no-API-key
 * library first. Gemini is opt-in only (`allowGemini`) — it's a paid API, so
 * callers must not use it as a silent, automatic fallback; the caller decides
 * when the user has actually asked for AI help. Never throws: callers should
 * treat a null result as "translation unavailable" and continue without
 * blocking on it.
 */
export async function translateText(
  text: string,
  language: string,
  allowGemini = false
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
  }

  if (!allowGemini) return null;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[translate] GEMINI_API_KEY not set; cannot fall back to Gemini");
    return null;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
    const languageName = language === "vi" ? "Vietnamese" : language;
    const prompt = `Translate the following English text into natural, conversational ${languageName}. Respond with only the translation, no commentary, no quotes.\n\n${trimmed}`;

    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Gemini translation timed out")), GEMINI_TIMEOUT_MS)
      ),
    ]);
    const translated = result.response.text().trim();
    if (translated) return { text: translated, source: "gemini" };
  } catch (err) {
    console.error("[translate] Gemini translation error:", err instanceof Error ? err.message : err);
  }

  return null;
}
