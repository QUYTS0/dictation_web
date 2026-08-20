import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { translateText } from "@/lib/translate";
import { lookupWordDetails } from "@/lib/dictionary";
import { lookupWordImage } from "@/lib/image";
import type { VocabularyPreviewRequest, VocabularyPreviewResponse } from "@/lib/types";

const PREVIEW_TRANSLATION_LANGUAGE = "vi";

/**
 * Live preview for the selection popover — translation, and for a single
 * word, dictionary details and an illustrative photo — shown before the
 * user decides to save anything. Free sources only (no Gemini — see
 * translate.ts for why it was removed from this path). Read-only and not
 * tied to any user data, so unlike /api/vocabulary it doesn't require auth;
 * it's rate-limited instead since it fires on every selection rather than
 * only on save.
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
    // reported back as `translationFailed` instead of collapsing into the
    // same null as "nothing to translate" — see translateText's throwOnFailure.
    const [{ translation, translationFailed }, wordDetails, image] = await Promise.all([
      translateText(text, PREVIEW_TRANSLATION_LANGUAGE, { throwOnFailure: true }).then(
        (value) => ({ translation: value, translationFailed: false }),
        () => ({ translation: null, translationFailed: true })
      ),
      body.isWord ? lookupWordDetails(text).catch(() => null) : Promise.resolve(null),
      body.isWord ? lookupWordImage(text).catch(() => null) : Promise.resolve(null),
    ]);

    return NextResponse.json<VocabularyPreviewResponse>({ translation, translationFailed, wordDetails, image });
  } catch (err) {
    console.error("[vocabulary/preview] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
