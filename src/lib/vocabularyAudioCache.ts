import { createHash } from "crypto";
import { createServiceClient } from "@/lib/supabase/server";

// Shared, content-addressed cache for Azure-synthesized vocabulary
// pronunciation audio (table: vocabulary_audio_assets; bucket:
// vocabulary-audio — see supabase/migrations/018, tightened by 019). Keyed
// purely by voice/locale/format/version + normalized text, so the same
// pronunciation looked up by any user, for any saved item, is served from
// one shared row/object — never synthesizing the same clip twice. Unlike
// translationCache.ts (whose table is intentionally public-read, since a
// dictionary translation isn't sensitive), both the table and the bucket
// here are service-role-only: `text`/`normalized_text` are a saved
// vocabulary item's own chosen term/phrase, which this app treats as
// private, and nothing in the client ever needs direct access to either —
// every read/write happens here, server-side, and playback URLs are
// resolved fresh (resolvePlaybackUrl, time-limited) per authenticated
// pronounce request. All read functions here are best-effort in the sense
// that a failure returns null/undefined rather than throwing — the
// pronounce route decides what to do about a cache miss, this module just
// reports one honestly. Writes (cacheAudioAsset) are NOT silently swallowed
// to null on failure the way translationCache's writer is — the caller (the
// pronounce route) must know whether the write actually succeeded before
// telling the client the audio is safely cached.

const TABLE = "vocabulary_audio_assets";
const BUCKET = "vocabulary-audio";
// The bucket and table are both service-role-only (see migration 019) — a
// resolved playback URL is a temporary, per-request credential, not a
// permanent identity, so it's given a bounded lifetime rather than never
// expiring. Comfortably longer than any single pronounce-request round
// trip; the client never persists this URL beyond one hook instance's
// in-memory lifetime, so a fresh one is simply requested again next time.
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export interface AudioAssetKey {
  voice: string;
  locale: string;
  outputFormat: string;
  synthesisVersion: string;
  normalizedText: string;
}

export interface CachedAudioAsset extends AudioAssetKey {
  id: string;
  storagePath: string;
}

/** True when a previously-linked/cached asset's own identity still matches
 *  the CURRENT expected synthesis identity (voice/locale/format/version/
 *  normalized text). An asset id or storage_path alone is never enough to
 *  trust — a stale link (e.g. left over from before `synthesis_version` was
 *  bumped) must fall through to a fresh lookup/synthesis rather than being
 *  served as if it still matched. */
export function assetMatchesKey(asset: AudioAssetKey, key: AudioAssetKey): boolean {
  return (
    asset.voice === key.voice &&
    asset.locale === key.locale &&
    asset.outputFormat === key.outputFormat &&
    asset.synthesisVersion === key.synthesisVersion &&
    asset.normalizedText === key.normalizedText
  );
}

/** Trims, collapses internal whitespace, and applies Unicode NFC — never
 *  lowercases or otherwise reshapes beyond that, so case/punctuation that
 *  changes pronunciation is never silently merged with a different input
 *  (see the `text` column's doc comment in migration 018). */
export function normalizeTtsText(text: string): string {
  return text.trim().replace(/\s+/g, " ").normalize("NFC");
}

function extensionForFormat(outputFormat: string): string {
  return outputFormat.includes("mp3") ? "mp3" : "wav";
}

function contentTypeForFormat(outputFormat: string): string {
  return outputFormat.includes("mp3") ? "audio/mpeg" : "audio/wav";
}

/** Deterministic content-addressed storage path — a retried upload after a
 *  partial failure overwrites the same key rather than accumulating
 *  orphaned objects. */
export function storagePathFor(key: AudioAssetKey): string {
  const hash = createHash("sha256")
    .update(`${key.voice}|${key.locale}|${key.outputFormat}|${key.synthesisVersion}|${key.normalizedText}`)
    .digest("hex");
  return `azure/${hash}.${extensionForFormat(key.outputFormat)}`;
}

/** Resolves a playable, time-limited URL for a stored object. The bucket
 *  and table are service-role-only (migration 019) — nothing about a saved
 *  vocabulary item's text is publicly queryable, and this signed URL is a
 *  temporary playback credential, not the asset's permanent identity (that
 *  remains its `id`/`storage_path`). Returns null on any failure
 *  (missing env vars, the object having gone missing from Storage, etc.) —
 *  callers treat that the same as "this asset is currently unusable" and
 *  fall through to a fresh lookup/synthesis rather than serving a broken
 *  reference. */
export async function resolvePlaybackUrl(storagePath: string): Promise<string | null> {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    if (error) {
      console.warn("[vocabularyAudioCache] createSignedUrl failed:", error.message);
      return null;
    }
    return data?.signedUrl ?? null;
  } catch (err) {
    console.warn("[vocabularyAudioCache] createSignedUrl failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

const ASSET_COLUMNS = "id, storage_path, voice, locale, output_format, synthesis_version, normalized_text";

function rowToAsset(data: Record<string, unknown>): CachedAudioAsset {
  return {
    id: data.id as string,
    storagePath: data.storage_path as string,
    voice: data.voice as string,
    locale: data.locale as string,
    outputFormat: data.output_format as string,
    synthesisVersion: data.synthesis_version as string,
    normalizedText: data.normalized_text as string,
  };
}

export async function getCachedAudioAsset(key: AudioAssetKey): Promise<CachedAudioAsset | null> {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from(TABLE)
      .select(ASSET_COLUMNS)
      .eq("voice", key.voice)
      .eq("locale", key.locale)
      .eq("output_format", key.outputFormat)
      .eq("synthesis_version", key.synthesisVersion)
      .eq("normalized_text", key.normalizedText)
      .maybeSingle();

    if (error) {
      console.warn("[vocabularyAudioCache] read failed:", error.message);
      return null;
    }
    if (!data) return null;
    return rowToAsset(data);
  } catch (err) {
    console.warn("[vocabularyAudioCache] read failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getAudioAssetById(id: string): Promise<CachedAudioAsset | null> {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.from(TABLE).select(ASSET_COLUMNS).eq("id", id).maybeSingle();

    if (error) {
      console.warn("[vocabularyAudioCache] read-by-id failed:", error.message);
      return null;
    }
    if (!data) return null;
    return rowToAsset(data);
  } catch (err) {
    console.warn("[vocabularyAudioCache] read-by-id failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Best-effort freshness bump — a failure here must never break playback. */
export async function touchAudioAsset(id: string): Promise<void> {
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from(TABLE).update({ last_used_at: new Date().toISOString() }).eq("id", id);
    if (error) console.warn("[vocabularyAudioCache] touch failed:", error.message);
  } catch (err) {
    console.warn("[vocabularyAudioCache] touch failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Uploads the audio bytes to Storage and upserts the cache row. Returns
 * null (and leaves no row behind) if either step fails — a partial cache
 * entry (a row with no bytes at its storage_path, or bytes with no row)
 * must never exist, so the next tap can safely retry synthesis from
 * scratch rather than serving/pointing at something broken. Unlike
 * translationCache's writer, failures here are NOT swallowed into a
 * fire-and-forget void — the pronounce route needs to know a write failed
 * so it can return TTS_STORAGE_ERROR instead of claiming success.
 */
export async function cacheAudioAsset(
  key: AudioAssetKey & { text: string; audio: Buffer; charCount: number }
): Promise<CachedAudioAsset | null> {
  const storagePath = storagePathFor(key);
  try {
    const supabase = createServiceClient();
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, key.audio, {
      contentType: contentTypeForFormat(key.outputFormat),
      upsert: true,
    });
    if (uploadError) {
      console.warn("[vocabularyAudioCache] storage upload failed:", uploadError.message);
      return null;
    }

    const { data, error } = await supabase
      .from(TABLE)
      .upsert(
        {
          provider: "azure_tts",
          text: key.text,
          normalized_text: key.normalizedText,
          voice: key.voice,
          locale: key.locale,
          output_format: key.outputFormat,
          synthesis_version: key.synthesisVersion,
          storage_path: storagePath,
          char_count: key.charCount,
          last_used_at: new Date().toISOString(),
        },
        { onConflict: "voice,locale,output_format,synthesis_version,normalized_text" }
      )
      .select(ASSET_COLUMNS)
      .single();

    if (error || !data) {
      console.warn("[vocabularyAudioCache] write failed:", error?.message);
      return null;
    }

    return rowToAsset(data);
  } catch (err) {
    console.warn("[vocabularyAudioCache] write failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
