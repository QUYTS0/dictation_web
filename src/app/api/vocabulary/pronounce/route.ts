import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkAzureTtsQuota, checkAzureTtsRate, isProductionEnvironment, isQuotaBackendConfigured } from "@/lib/rateLimit";
import {
  AzureTtsError,
  DEFAULT_TTS_LOCALE,
  DEFAULT_TTS_OUTPUT_FORMAT,
  DEFAULT_TTS_VOICE,
  TTS_SYNTHESIS_VERSION,
  isAzureTtsConfigured,
  synthesizeSpeech,
} from "@/lib/azureTts";
import {
  assetMatchesKey,
  cacheAudioAsset,
  getAudioAssetById,
  getCachedAudioAsset,
  normalizeTtsText,
  resolvePlaybackUrl,
  touchAudioAsset,
  type AudioAssetKey,
} from "@/lib/vocabularyAudioCache";
import type { TtsErrorCode, VocabularyItem, VocabularyPronounceRequest } from "@/lib/types";

/** Generous headroom over real values — a defensive bound against a
 *  malformed/oversized canonical_form, not a meaningful product constraint.
 *  Matches MAX_METADATA_FIELD_LENGTH in the main vocabulary route (both
 *  values must stay in sync since canonical_form is written there and read
 *  here). */
const MAX_TEXT_TO_SPEAK_LENGTH = 200;
const DEFAULT_MONTHLY_CHAR_BUDGET = 400_000;

function errorResponse(code: TtsErrorCode, message: string, status: number) {
  return NextResponse.json({ error: message, code }, { status });
}

type SupabaseRequestClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Best-effort AND conditional — a failure to link, or a guard mismatch,
 * just means the next tap redoes this same cache lookup instead of
 * skipping straight to it; it must never fail the response that's already
 * about to return a perfectly good, playable audioUrl.
 *
 * The `.eq("normalized_term", ...)`/canonical_form guard is the fix for a
 * real race: this asset was resolved for whatever text `item` held at the
 * START of this request. If the user edits the item's term (or it
 * otherwise gets its canonical_form invalidated) while synthesis/lookup was
 * still in flight, an unconditional UPDATE here would silently re-attach
 * this now-stale asset to the item's NEW text — exactly the "play A while
 * displaying B" bug this guard exists to prevent. A no-op update (0 rows
 * matched) is the correct, silent outcome in that case; the asset itself
 * remains in the shared cache for whatever item legitimately needs that
 * text next.
 */
async function linkAssetToItem(
  supabase: SupabaseRequestClient,
  itemId: string,
  assetId: string,
  guard: { normalizedTerm: string; canonicalForm: string | null }
): Promise<void> {
  let query = supabase
    .from("vocabulary_items")
    .update({ pronunciation_audio_asset_id: assetId })
    .eq("id", itemId)
    .eq("normalized_term", guard.normalizedTerm);
  query = guard.canonicalForm === null ? query.is("canonical_form", null) : query.eq("canonical_form", guard.canonicalForm);
  const { error } = await query;
  if (error) console.warn("[vocabulary/pronounce] link asset failed:", error.message);
}

/**
 * Resolves (and, if necessary, generates) a playable pronunciation URL for
 * one saved vocabulary item. Request carries only `itemId` (plus the
 * explicit, user-initiated `preferGenerated` recovery flag) — never raw
 * text — so what gets spoken is always server-derived from the owned row,
 * closing off arbitrary-TTS abuse by construction. See "Vocabulary Audio
 * Audit and Azure TTS Plan.md" §7 for the original decision flow, and its
 * "post-implementation audit" addendum for why the resolution order below
 * differs from that original write-up (asset-identity validation, the
 * conditional link, and the dictionary-shortcut reordering all closed
 * confirmed defects found in review).
 */
export async function POST(request: NextRequest) {
  try {
    const body: VocabularyPronounceRequest = await request.json();
    const itemId = body?.itemId;
    if (!itemId || typeof itemId !== "string") {
      return NextResponse.json({ error: "itemId is required" }, { status: 400 });
    }
    const preferGenerated = body?.preferGenerated === true;

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data, error: itemError } = await supabase
      .from("vocabulary_items")
      .select("*")
      .eq("id", itemId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (itemError) {
      console.error("[vocabulary/pronounce] item lookup error:", itemError);
      return errorResponse("TTS_UPSTREAM_ERROR", "Failed to resolve pronunciation.", 500);
    }
    if (!data) {
      return errorResponse("NOT_FOUND", "Vocabulary item not found.", 404);
    }
    const item = data as VocabularyItem;

    // Deliberately not re-deriving from the live highlight cache
    // server-side — that fallback exists only for the client's
    // currently-loaded-video convenience. The persisted column is the
    // server's source of truth. (A legacy row where the two would
    // otherwise disagree gets its canonical_form backfilled by the client
    // the moment it's opened — see VocabularyDetailDialog's backfill
    // effect — specifically so this stays true instead of silently
    // diverging from what the heading shows.)
    const textToSpeak = (item.canonical_form ?? item.term).trim().slice(0, MAX_TEXT_TO_SPEAK_LENGTH);
    if (!textToSpeak) {
      return errorResponse("NOT_FOUND", "Vocabulary item not found.", 404);
    }
    const linkGuard = { normalizedTerm: item.normalized_term, canonicalForm: item.canonical_form };

    const isWord = !/\s/.test(item.term.trim());
    const cacheKey: AudioAssetKey = {
      voice: DEFAULT_TTS_VOICE,
      locale: DEFAULT_TTS_LOCALE,
      outputFormat: DEFAULT_TTS_OUTPUT_FORMAT,
      synthesisVersion: TTS_SYNTHESIS_VERSION,
      normalizedText: normalizeTtsText(textToSpeak),
    };

    // 1. Already resolved to a linked Azure asset on a previous tap (or an
    // earlier "use generated pronunciation" recovery) — checked BEFORE the
    // dictionary shortcut below so that once a generated alternative has
    // been explicitly linked, it keeps being preferred on every later open
    // rather than falling back to a still-broken dictionary URL again.
    // Never trusted on the asset id alone: an asset whose own identity no
    // longer matches the current voice/locale/format/synthesis_version/
    // text (e.g. left over from before TTS_SYNTHESIS_VERSION was bumped)
    // is treated as stale and falls through instead of being served.
    if (item.pronunciation_audio_asset_id) {
      const asset = await getAudioAssetById(item.pronunciation_audio_asset_id);
      if (asset && assetMatchesKey(asset, cacheKey)) {
        const url = await resolvePlaybackUrl(asset.storagePath);
        if (url) {
          void touchAudioAsset(asset.id);
          return NextResponse.json({ audioUrl: url, source: "cached" });
        }
        // Identity matched but Storage couldn't resolve a URL (e.g. the
        // object itself has gone missing) — falls through below rather
        // than trapping playback on a permanently unusable reference.
      }
      // Stale identity, or unreadable — falls through to a fresh cache
      // lookup/synthesis; the guarded link below will correct the FK once
      // a current asset is resolved.
    }

    // 2. Dictionary audio, single words only — never calls Azure. Skipped
    // entirely when the caller explicitly asked for a generated
    // alternative (the bounded "Use generated pronunciation" recovery
    // action for unusable dictionary audio — never triggered automatically).
    if (item.audio_url && isWord && !preferGenerated) {
      return NextResponse.json({ audioUrl: item.audio_url, source: "dictionary" });
    }

    // 3. Shared cache hit — any item, any user, same normalized text/voice/version.
    const cached = await getCachedAudioAsset(cacheKey);
    if (cached) {
      const url = await resolvePlaybackUrl(cached.storagePath);
      if (url) {
        void linkAssetToItem(supabase, itemId, cached.id, linkGuard);
        void touchAudioAsset(cached.id);
        return NextResponse.json({ audioUrl: url, source: "cached" });
      }
      // Row exists but its Storage object is unreadable — treated as a
      // miss below; re-synthesizing will `upsert` onto the same row,
      // self-healing the shared cache for every item that needs this text.
    }

    // 4. Miss — synthesize on demand.
    if (!isAzureTtsConfigured()) {
      return errorResponse("TTS_NOT_CONFIGURED", "Pronunciation isn't configured on the server.", 503);
    }

    // New synthesis must fail CLOSED, not open, when the app cannot
    // actually enforce its configured budget — unlike every other quota in
    // this codebase (which fails open when Upstash isn't configured, a
    // deliberate convenience for local dev), this one gates a real,
    // metered Azure cost. Dictionary audio and any already-cached asset
    // never reach this point at all (see steps 1-3), so they keep working
    // regardless of Upstash's availability. Scoped to production only —
    // local dev/tests without a live Upstash instance still work exactly
    // as they did before, matching this codebase's established convention
    // everywhere else.
    const isProduction = isProductionEnvironment();
    if (isProduction && !isQuotaBackendConfigured()) {
      return errorResponse(
        "TTS_QUOTA_EXCEEDED",
        "Pronunciation is temporarily unavailable — quota enforcement is unreachable.",
        503
      );
    }

    const monthlyBudget = Number(process.env.AZURE_TTS_MONTHLY_CHAR_BUDGET ?? DEFAULT_MONTHLY_CHAR_BUDGET);
    let quota: { allowed: boolean };
    let rate: { allowed: boolean };
    try {
      quota = await checkAzureTtsQuota(cacheKey.normalizedText.length, monthlyBudget);
      rate = quota.allowed ? await checkAzureTtsRate() : { allowed: true };
    } catch (err) {
      console.error("[vocabulary/pronounce] quota backend error:", err instanceof Error ? err.message : err);
      if (isProduction) {
        return errorResponse(
          "TTS_QUOTA_EXCEEDED",
          "Pronunciation is temporarily unavailable — quota enforcement is unreachable.",
          503
        );
      }
      quota = { allowed: true };
      rate = { allowed: true };
    }
    if (!quota.allowed) {
      return errorResponse("TTS_QUOTA_EXCEEDED", "Pronunciation is temporarily unavailable. Please try again later.", 429);
    }
    if (!rate.allowed) {
      return errorResponse("TTS_RATE_LIMITED", "Too many pronunciation requests. Please try again shortly.", 429);
    }

    let synthesis;
    try {
      synthesis = await synthesizeSpeech({
        text: textToSpeak,
        voice: cacheKey.voice,
        locale: cacheKey.locale,
        outputFormat: cacheKey.outputFormat,
      });
    } catch (err) {
      const code: TtsErrorCode = err instanceof AzureTtsError ? err.code : "TTS_UPSTREAM_ERROR";
      console.error("[vocabulary/pronounce] synthesis failed:", err instanceof Error ? err.message : err);
      return errorResponse(code, "Couldn't generate pronunciation. Please try again.", 502);
    }

    const asset = await cacheAudioAsset({
      ...cacheKey,
      text: textToSpeak,
      audio: synthesis.audio,
      charCount: cacheKey.normalizedText.length,
    });
    if (!asset) {
      return errorResponse("TTS_STORAGE_ERROR", "Couldn't save the generated pronunciation. Please try again.", 502);
    }

    const url = await resolvePlaybackUrl(asset.storagePath);
    if (!url) {
      return errorResponse("TTS_STORAGE_ERROR", "Couldn't save the generated pronunciation. Please try again.", 502);
    }

    void linkAssetToItem(supabase, itemId, asset.id, linkGuard);

    return NextResponse.json({ audioUrl: url, source: "synthesized" });
  } catch (err) {
    console.error("[vocabulary/pronounce] unexpected error:", err);
    return errorResponse("TTS_UPSTREAM_ERROR", "Internal server error", 500);
  }
}
