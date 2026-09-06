import { createServiceClient } from "@/lib/supabase/server";
import type { SelectionType } from "@/lib/azureTranslator";

// Shared cache for ad-hoc vocabulary word/phrase/sentence lookups (table:
// vocabulary_translation_cache — see supabase/migrations). Distinct from
// transcript_translations, which caches whole-segment transcript
// translations for a specific transcript_id. This cache is keyed purely by
// the normalized text (language pair + selection type), so the same word
// looked up by any user, on any video, is served from one shared row —
// never consuming Azure quota twice for the same input.
//
// Both functions are best-effort: a cache read/write failure (missing
// Supabase env vars, a transient DB error) must never break translation
// itself — it just means this lookup falls through to a live Azure call.
// Callers don't need their own try/catch around these.

const TABLE = "vocabulary_translation_cache";

export interface TranslationCacheAlternative {
  text: string;
  partOfSpeech?: string | null;
}

export interface TranslationCacheMetadata {
  alternatives?: TranslationCacheAlternative[];
}

interface CacheKey {
  sourceLanguage: string;
  targetLanguage: string;
  selectionType: SelectionType;
  normalizedText: string;
}

export interface CachedTranslation {
  translation: string;
  metadata: TranslationCacheMetadata | null;
}

export async function getCachedTranslation(key: CacheKey): Promise<CachedTranslation | null> {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from(TABLE)
      .select("translation, metadata")
      .eq("source_language", key.sourceLanguage)
      .eq("target_language", key.targetLanguage)
      .eq("selection_type", key.selectionType)
      .eq("normalized_text", key.normalizedText)
      .maybeSingle();

    if (error) {
      console.warn("[translationCache] read failed:", error.message);
      return null;
    }
    if (!data) return null;

    return {
      translation: data.translation as string,
      metadata: (data.metadata as TranslationCacheMetadata | null) ?? null,
    };
  } catch (err) {
    console.warn("[translationCache] read failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function setCachedTranslation(
  key: CacheKey & { translation: string; metadata?: TranslationCacheMetadata }
): Promise<void> {
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from(TABLE).upsert(
      {
        source_language: key.sourceLanguage,
        target_language: key.targetLanguage,
        selection_type: key.selectionType,
        normalized_text: key.normalizedText,
        translation: key.translation,
        provider: "azure",
        metadata: key.metadata ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source_language,target_language,selection_type,normalized_text" }
    );

    if (error) {
      console.warn("[translationCache] write failed:", error.message);
    }
  } catch (err) {
    console.warn("[translationCache] write failed:", err instanceof Error ? err.message : err);
  }
}
