import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { translateText, TranslationError } from "@/lib/translate";
import { lookupWordDetails } from "@/lib/dictionary";
import { lookupWordImage } from "@/lib/image";
import type { VocabularyPreviewRequest, VocabularyPreviewResponse, TranslationErrorCode } from "@/lib/types";

const PREVIEW_TRANSLATION_LANGUAGE = "vi";

function toTranslationErrorPayload(err: unknown): { code: TranslationErrorCode; message: string } {
  if (err instanceof TranslationError) {
    return { code: err.code, message: err.message };
  }
  return {
    code: "TRANSLATION_SERVICE_ERROR",
    message: "Translation is temporarily unavailable. Please try again later.",
  };
}

/**
 * Live preview for the selection popover — translation (via Azure
 * Translator; see lib/translate.ts), and for a single word, dictionary
 * details and an illustrative photo — shown before the user decides to
 * save anything. Read-only and not tied to any user data, so unlike
 * /api/vocabulary it doesn't require auth; it's rate-limited instead since
 * it fires on every selection rather than only on save.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, "vocabulary/preview", {
      limit: 60,
      windowMs: 60_000,
    });
    if (rateLimitResponse) return rateLimitResponse;

    const body: VocabularyPreviewRequest = await request.json();
    const text = body.text?.trim();
    if (!text) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    // All three fire concurrently; translation's outcome is captured via
    // .then's two callbacks (rather than a plain .catch) so a failure can be
    // reported back as a typed `translationError` instead of collapsing
    // into the same null as "nothing to translate".
    const [translationOutcome, wordDetails, image] = await Promise.all([
      translateText(text, PREVIEW_TRANSLATION_LANGUAGE).then(
        (value) => ({ translation: value, translationError: null }),
        (err: unknown) => ({ translation: null, translationError: toTranslationErrorPayload(err) })
      ),
      body.isWord ? lookupWordDetails(text).catch(() => null) : Promise.resolve(null),
      body.isWord ? lookupWordImage(text).catch(() => null) : Promise.resolve(null),
    ]);

    return NextResponse.json<VocabularyPreviewResponse>({
      translation: translationOutcome.translation,
      translationFailed: !!translationOutcome.translationError,
      translationError: translationOutcome.translationError,
      wordDetails,
      image,
    });
  } catch (err) {
    console.error("[vocabulary/preview] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
