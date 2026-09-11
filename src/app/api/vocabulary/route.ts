import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeVocabularyTerm } from "@/lib/utils/vocabulary";
import { checkRateLimit } from "@/lib/rateLimit";
import { translateText } from "@/lib/translate";
import { lookupWordDetails } from "@/lib/dictionary";
import { lookupWordImage } from "@/lib/image";
import type { VocabularyItem, VocabularyRequest, VocabularyUpdateRequest } from "@/lib/types";

const VOCABULARY_TRANSLATION_LANGUAGE = "vi";

/** Generous headroom over real values (e.g. "go a long way toward(s) +
 *  noun/V-ing") — just a defensive bound against malformed/oversized input,
 *  not a meaningful product constraint. */
const MAX_METADATA_FIELD_LENGTH = 200;

/** Trims and collapses internal whitespace; empty after trimming becomes
 *  null (never an empty string) so `canonical_form ?? term` fallbacks work
 *  correctly downstream. Truncates rather than rejecting an over-long value
 *  — canonical form/pattern are pipeline-derived, not attacker-controlled
 *  free text, so truncation is a safe defensive bound. */
function normalizeOptionalMetadata(value: string): string | null {
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (!collapsed) return null;
  return collapsed.length > MAX_METADATA_FIELD_LENGTH ? collapsed.slice(0, MAX_METADATA_FIELD_LENGTH) : collapsed;
}

/** true when `value` is present in the body but not a valid optional-string
 *  field (i.e. neither absent/undefined nor a string) — used to reject
 *  malformed canonicalForm/learningPattern input (arrays/objects/numbers)
 *  with a 400 instead of silently coercing or crashing on `.trim()`. */
function isInvalidOptionalMetadata(value: unknown): boolean {
  return value !== undefined && typeof value !== "string";
}

export async function GET(request: NextRequest) {
  try {
    const videoId = request.nextUrl.searchParams.get("videoId");
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    let query = supabase
      .from("vocabulary_items")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (videoId) {
      query = query.eq("video_id", videoId);
    }

    const { data, error } = await query;
    if (error) {
      console.error("[vocabulary] list error:", error);
      return NextResponse.json({ error: "Failed to fetch vocabulary" }, { status: 500 });
    }

    return NextResponse.json({ items: (data ?? []) as VocabularyItem[] });
  } catch (err) {
    console.error("[vocabulary] unexpected GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, "vocabulary/save", {
      limit: 30,
      windowMs: 60_000,
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body: VocabularyRequest = await request.json();
    const {
      videoId,
      segmentIndex,
      term,
      sentenceContext,
      note,
      canonicalForm,
      learningPattern,
      translation: precomputedTranslation,
      translationSource: precomputedTranslationSource,
      phonetic: precomputedPhonetic,
      partOfSpeech: precomputedPartOfSpeech,
      definition: precomputedDefinition,
      definitionSource: precomputedDefinitionSource,
      audioUrl: precomputedAudioUrl,
      imageUrl: precomputedImageUrl,
      imageThumbnailUrl: precomputedImageThumbnailUrl,
      imageAttribution: precomputedImageAttribution,
      imageSourceUrl: precomputedImageSourceUrl,
    } = body;

    if (!videoId || typeof segmentIndex !== "number" || !term || !sentenceContext) {
      return NextResponse.json(
        { error: "videoId, segmentIndex, term and sentenceContext are required" },
        { status: 400 }
      );
    }

    if (isInvalidOptionalMetadata(canonicalForm) || isInvalidOptionalMetadata(learningPattern)) {
      return NextResponse.json({ error: "canonicalForm and learningPattern must be strings when provided" }, { status: 400 });
    }

    const normalizedTerm = normalizeVocabularyTerm(term);
    if (!normalizedTerm) {
      return NextResponse.json({ error: "term cannot be empty" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    // The popover's live preview usually already fetched these — reuse them
    // instead of looking everything up again. Falls back to a fresh
    // best-effort, free-only lookup (never blocks the save) if the caller
    // didn't send them.
    const translation = precomputedTranslation
      ? { text: precomputedTranslation, source: precomputedTranslationSource ?? "azure" }
      : await translateText(term.trim(), VOCABULARY_TRANSLATION_LANGUAGE).catch(() => null);

    const wordDetails = precomputedDefinition
      ? {
          phonetic: precomputedPhonetic ?? null,
          partOfSpeech: precomputedPartOfSpeech ?? null,
          definition: precomputedDefinition,
          audioUrl: precomputedAudioUrl ?? null,
          source: precomputedDefinitionSource ?? "free_dictionary",
        }
      : await lookupWordDetails(term.trim()).catch(() => null);

    // Images are always free (Openverse, no key) — no gating needed.
    const image = precomputedImageUrl
      ? {
          url: precomputedImageUrl,
          thumbnailUrl: precomputedImageThumbnailUrl ?? precomputedImageUrl,
          attribution: precomputedImageAttribution ?? null,
          sourceUrl: precomputedImageSourceUrl ?? null,
        }
      : await lookupWordImage(term.trim()).catch(() => null);

    const dedupeFilter = {
      user_id: user.id,
      video_id: videoId,
      segment_index: segmentIndex,
      normalized_term: normalizedTerm,
    };

    const { data: existing, error: existingError } = await supabase
      .from("vocabulary_items")
      .select("id")
      .match(dedupeFilter)
      .maybeSingle();

    if (existingError) {
      console.error("[vocabulary] dedupe query error:", existingError);
      return NextResponse.json({ error: "Failed to save vocabulary item" }, { status: 500 });
    }

    const basePayload = {
      ...dedupeFilter,
      term: term.trim(),
      sentence_context: sentenceContext.trim(),
      note: note?.trim() || null,
      translation: translation?.text ?? null,
      translation_language: VOCABULARY_TRANSLATION_LANGUAGE,
      translation_source: translation?.source ?? null,
      phonetic: wordDetails?.phonetic ?? null,
      part_of_speech: wordDetails?.partOfSpeech ?? null,
      definition: wordDetails?.definition ?? null,
      definition_source: wordDetails?.source ?? null,
      audio_url: wordDetails?.audioUrl ?? null,
      image_url: image?.url ?? null,
      image_thumbnail_url: image?.thumbnailUrl ?? null,
      image_attribution: image?.attribution ?? null,
      image_source_url: image?.sourceUrl ?? null,
    };

    let data;
    let error;
    if (existing) {
      // Update branch: canonicalForm/learningPattern use preserve-on-omit
      // semantics, not the insert branch's default-to-null — a note-only
      // edit, or a re-save from a manual selection with no highlight match,
      // must never blank out canonical metadata a previous save already
      // attached to this row. Only add the key to the update payload when
      // the field was actually present in this request.
      const updatePayload: Record<string, unknown> = { ...basePayload };
      if (canonicalForm !== undefined) updatePayload.canonical_form = normalizeOptionalMetadata(canonicalForm);
      if (learningPattern !== undefined) updatePayload.learning_pattern = normalizeOptionalMetadata(learningPattern);

      const result = await supabase
        .from("vocabulary_items")
        .update(updatePayload)
        .eq("id", existing.id)
        .select("*")
        .single();
      data = result.data;
      error = result.error;
    } else {
      // Insert branch: no existing value to preserve, so an omitted field
      // naturally becomes null here.
      const insertPayload = {
        ...basePayload,
        canonical_form: canonicalForm !== undefined ? normalizeOptionalMetadata(canonicalForm) : null,
        learning_pattern: learningPattern !== undefined ? normalizeOptionalMetadata(learningPattern) : null,
      };
      const result = await supabase.from("vocabulary_items").insert(insertPayload).select("*").single();
      data = result.data;
      error = result.error;
    }

    if (error || !data) {
      console.error("[vocabulary] save error:", error);
      return NextResponse.json({ error: "Failed to save vocabulary item" }, { status: 500 });
    }

    return NextResponse.json({ item: data as VocabularyItem });
  } catch (err) {
    console.error("[vocabulary] unexpected POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("vocabulary_items")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id");

    if (error) {
      console.error("[vocabulary] delete error:", error);
      return NextResponse.json({ error: "Failed to delete vocabulary item" }, { status: 500 });
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Vocabulary item not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[vocabulary] unexpected DELETE error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body: VocabularyUpdateRequest = await request.json();
    const { id, term, sentenceContext, note, translation, phonetic, partOfSpeech, definition, canonicalForm, learningPattern } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    if (isInvalidOptionalMetadata(canonicalForm) || isInvalidOptionalMetadata(learningPattern)) {
      return NextResponse.json({ error: "canonicalForm and learningPattern must be strings when provided" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data: existing, error: existingError } = await supabase
      .from("vocabulary_items")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingError) {
      console.error("[vocabulary] PATCH existing query error:", existingError);
      return NextResponse.json({ error: "Failed to update vocabulary item" }, { status: 500 });
    }

    if (!existing) {
      return NextResponse.json({ error: "Vocabulary item not found" }, { status: 404 });
    }

    const nextTerm = (term ?? existing.term).trim();
    const nextSentenceContext = (sentenceContext ?? existing.sentence_context).trim();
    const normalizedTerm = normalizeVocabularyTerm(nextTerm);
    if (!normalizedTerm) {
      return NextResponse.json({ error: "term cannot be empty" }, { status: 400 });
    }
    if (!nextSentenceContext) {
      return NextResponse.json({ error: "sentenceContext cannot be empty" }, { status: 400 });
    }

    // Term-derived metadata (dictionary lookup results, canonical/learning
    // metadata, and any resolved pronunciation audio) was all resolved
    // against the OLD term. When the term actually changes, null all of it
    // out unconditionally rather than trying to reconcile it with whatever
    // the request body also happens to carry — this forces a fresh lookup
    // next time instead of silently keeping stale audio/definitions
    // attached to unrelated text. Non-term edits keep the existing
    // preserve-on-omit / explicit-value-wins behavior untouched.
    const termChanged = normalizedTerm !== existing.normalized_term;

    const payload = {
      term: nextTerm,
      normalized_term: normalizedTerm,
      sentence_context: nextSentenceContext,
      note:
        note === undefined
          ? existing.note
          : typeof note === "string"
          ? note.trim() || null
          : null,
      translation:
        translation === undefined
          ? existing.translation
          : typeof translation === "string"
          ? translation.trim() || null
          : null,
      phonetic: termChanged
        ? null
        : phonetic === undefined
        ? existing.phonetic
        : typeof phonetic === "string"
        ? phonetic.trim() || null
        : null,
      part_of_speech: termChanged
        ? null
        : partOfSpeech === undefined
        ? existing.part_of_speech
        : typeof partOfSpeech === "string"
        ? partOfSpeech.trim() || null
        : null,
      definition: termChanged
        ? null
        : definition === undefined
        ? existing.definition
        : typeof definition === "string"
        ? definition.trim() || null
        : null,
      definition_source: termChanged ? null : existing.definition_source,
      // Backfill-only exception to "leave untouched otherwise": when the
      // term isn't changing and the persisted column is currently null, an
      // explicitly supplied canonicalForm/learningPattern is allowed to
      // fill it in — this is how the client catches up a legacy row's
      // server-side truth to match what it's already resolving via the
      // live highlight-cache fallback (see resolveVocabularyHighlightMeta),
      // so pronunciation (which only ever reads the persisted column) stops
      // disagreeing with the displayed heading. Never overwrites an
      // existing non-null value — that would risk silently discarding a
      // verified normalization for a heuristic one.
      canonical_form: termChanged
        ? null
        : canonicalForm !== undefined && existing.canonical_form == null
        ? normalizeOptionalMetadata(canonicalForm)
        : existing.canonical_form,
      learning_pattern: termChanged
        ? null
        : learningPattern !== undefined && existing.learning_pattern == null
        ? normalizeOptionalMetadata(learningPattern)
        : existing.learning_pattern,
      audio_url: termChanged ? null : existing.audio_url,
      pronunciation_audio_asset_id: termChanged ? null : existing.pronunciation_audio_asset_id,
    };

    const { data, error } = await supabase
      .from("vocabulary_items")
      .update(payload)
      .eq("id", id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error || !data) {
      console.error("[vocabulary] PATCH update error:", error);
      if (error?.code === "23505") {
        return NextResponse.json({ error: "A matching vocabulary item already exists." }, { status: 409 });
      }
      return NextResponse.json({ error: "Failed to update vocabulary item" }, { status: 500 });
    }

    return NextResponse.json({ item: data as VocabularyItem });
  } catch (err) {
    console.error("[vocabulary] unexpected PATCH error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
