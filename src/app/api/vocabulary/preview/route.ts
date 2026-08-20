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
 * user decides to save anything. Read-only and not tied to any user data,
 * so unlike /api/vocabulary it doesn't require auth; it's rate-limited
 * instead since it fires on every selection rather than only on save.
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

    // Gemini is opt-in (paid) — gate it behind its own, tighter rate limit
    // so it can't be hammered even by a legitimate client bug.
    if (body.useAI) {
      const aiRateLimitResponse = await checkRateLimit(request, "vocabulary/preview-ai", {
        limit: 10,
        windowMs: 60_000,
      });
      if (aiRateLimitResponse) return aiRateLimitResponse;
    }

    const [translation, wordDetails, image] = await Promise.all([
      translateText(text, PREVIEW_TRANSLATION_LANGUAGE, body.useAI).catch(() => null),
      body.isWord ? lookupWordDetails(text, body.useAI).catch(() => null) : Promise.resolve(null),
      body.isWord ? lookupWordImage(text).catch(() => null) : Promise.resolve(null),
    ]);

    return NextResponse.json<VocabularyPreviewResponse>({ translation, wordDetails, image });
  } catch (err) {
    console.error("[vocabulary/preview] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
