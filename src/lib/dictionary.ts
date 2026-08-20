import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { GEMINI_MODEL_NAME } from "@/lib/gemini";

const GEMINI_TIMEOUT_MS = 4_000;
const FREE_DICTIONARY_TIMEOUT_MS = 3_000;

export type DictionarySource = "free_dictionary" | "gemini";

export interface WordDetails {
  phonetic: string | null;
  partOfSpeech: string | null;
  definition: string | null;
  example: string | null;
  audioUrl: string | null;
  source: DictionarySource;
}

interface FreeDictionaryPhonetic {
  text?: string;
  audio?: string;
}

interface FreeDictionaryDefinition {
  definition?: string;
  example?: string;
}

interface FreeDictionaryMeaning {
  partOfSpeech?: string;
  definitions?: FreeDictionaryDefinition[];
}

interface FreeDictionaryEntry {
  phonetic?: string;
  phonetics?: FreeDictionaryPhonetic[];
  meanings?: FreeDictionaryMeaning[];
}

const WORD_DETAILS_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    phonetic: { type: SchemaType.STRING },
    partOfSpeech: { type: SchemaType.STRING },
    definition: { type: SchemaType.STRING },
    example: { type: SchemaType.STRING },
  },
  required: ["phonetic", "partOfSpeech", "definition"],
};

/**
 * Oxford-style word details (phonetic/POS/definition/example) for a single
 * English word — free first, Gemini only when the word isn't in the free
 * dictionary's database. Never throws: a null result just means "no dictionary
 * entry available," which callers should treat as non-fatal.
 * Gemini is opt-in only (`allowGemini`) — it's a paid API, so it must never
 * fire as a silent automatic fallback; the caller decides when the user has
 * actually asked for AI help.
 */
export async function lookupWordDetails(word: string, allowGemini = false): Promise<WordDetails | null> {
  const trimmed = word.trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const freeResult = await lookupFreeDictionary(trimmed);
  if (freeResult) return freeResult;

  if (!allowGemini) return null;
  return lookupGemini(trimmed);
}

async function lookupFreeDictionary(word: string): Promise<WordDetails | null> {
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
      signal: AbortSignal.timeout(FREE_DICTIONARY_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const entries = (await res.json()) as FreeDictionaryEntry[];
    const entry = entries[0];
    if (!entry) return null;

    const meaning = entry.meanings?.find((m) => m.definitions?.[0]?.definition);
    const definition = meaning?.definitions?.[0];
    if (!definition?.definition) return null;

    const phoneticEntry = entry.phonetics?.find((p) => p.text) ?? entry.phonetics?.[0];
    const audioEntry = entry.phonetics?.find((p) => p.audio);

    return {
      phonetic: phoneticEntry?.text || entry.phonetic || null,
      partOfSpeech: meaning?.partOfSpeech || null,
      definition: definition.definition,
      example: definition.example || null,
      audioUrl: audioEntry?.audio || null,
      source: "free_dictionary",
    };
  } catch (err) {
    console.warn(
      "[dictionary] free dictionary lookup failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function lookupGemini(word: string): Promise<WordDetails | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[dictionary] GEMINI_API_KEY not set; cannot fall back to Gemini");
    return null;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL_NAME,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: WORD_DETAILS_SCHEMA,
      },
    });
    const prompt = `Give a concise, Oxford-dictionary-style entry for the English word "${word}": its IPA pronunciation, primary part of speech, a short clear definition, and (if natural) a short example sentence. Respond with only the JSON object.`;

    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Gemini word lookup timed out")), GEMINI_TIMEOUT_MS)
      ),
    ]);
    const rawText = result.response.text().trim();
    const jsonStr = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/, "");
    const parsed = JSON.parse(jsonStr) as {
      phonetic?: string;
      partOfSpeech?: string;
      definition?: string;
      example?: string;
    };
    if (!parsed.definition) return null;

    return {
      phonetic: parsed.phonetic || null,
      partOfSpeech: parsed.partOfSpeech || null,
      definition: parsed.definition,
      example: parsed.example || null,
      audioUrl: null,
      source: "gemini",
    };
  } catch (err) {
    console.error("[dictionary] Gemini word lookup error:", err instanceof Error ? err.message : err);
    return null;
  }
}
