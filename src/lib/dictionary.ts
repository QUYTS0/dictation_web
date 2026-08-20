export type DictionarySource = "free_dictionary";

export interface WordDetails {
  phonetic: string | null;
  partOfSpeech: string | null;
  definition: string | null;
  example: string | null;
  audioUrl: string | null;
  source: DictionarySource;
}

const FREE_DICTIONARY_TIMEOUT_MS = 3_000;

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

/**
 * Oxford-style word details (phonetic/POS/definition/example) for a single
 * English word, from the free dictionaryapi.dev lookup only. Gemini was
 * removed from this path (2026-08) — see translate.ts for why. Never
 * throws: a null result just means "no dictionary entry available," which
 * callers should treat as non-fatal.
 */
export async function lookupWordDetails(word: string): Promise<WordDetails | null> {
  const trimmed = word.trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return null;

  return lookupFreeDictionary(trimmed);
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
