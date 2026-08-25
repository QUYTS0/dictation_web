import { NextRequest, NextResponse } from "next/server";
import { YoutubeTranscript } from "youtube-transcript";
import { translate } from "@vitalets/google-translate-api";
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit, checkGeminiQuota } from "@/lib/rateLimit";
import { normalizeCues } from "@/lib/utils/segment";
import { fetchYoutubeTranslatedCaptions } from "@/lib/youtubeTranslatedCaptions";
import { GEMINI_MODEL_NAME } from "@/lib/gemini";
import type {
  TranslateTranscriptRequest,
  TranslateTranscriptResponse,
  TranslationSegment,
  TranslationSource,
} from "@/lib/types";

const GEMINI_TIMEOUT_MS = 20_000;

// Objects tagged with their own 1-based `index`, not a bare positional
// array of strings — see buildTranslationPrompt for why: a plain array lets
// Gemini silently merge a couple of short/related sentences into one
// translation while still padding its output back to the expected length by
// re-splitting something else, which passes a length-only check but shifts
// every later segment's translation onto the wrong sentence. Tagging each
// answer with the index it's for lets the parser below catch that instead
// of just trusting position.
const TRANSLATION_RESPONSE_SCHEMA: Schema = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      index: { type: SchemaType.NUMBER },
      translation: { type: SchemaType.STRING },
    },
    required: ["index", "translation"],
  },
};

interface EnglishSegmentRow {
  segment_index: number;
  start_sec: number;
  end_sec: number;
  text_raw: string;
}

/**
 * Translates a transcript's segments to `language` (default Vietnamese),
 * trying progressively more expensive tiers and caching each result:
 *   1a. YouTube's own captions already in the target language, if the video
 *       happens to have a distinct track for it (rare).
 *   1b. Otherwise, YouTube's server-side auto-translate ("tlang") of
 *       whatever caption track the video does have — still YouTube's own
 *       translation, just requested on the fly instead of relying on a
 *       pre-existing track. Covers most videos, since most have at least
 *       English auto-captions.
 *   2. A free, no-API-key translation library (best effort — the unofficial
 *      endpoint it hits can be rate-limited on shared serverless IPs).
 *   3. Gemini, for whatever segments are still untranslated after 1 and 2.
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "transcript/translate", {
    limit: 5,
    windowMs: 60_000,
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body: TranslateTranscriptRequest = await request.json();
    const { videoId, transcriptId, language = "vi", force = false } = body;

    if (!videoId || !transcriptId) {
      return NextResponse.json(
        { error: "videoId and transcriptId are required" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    const { data: englishSegmentRows, error: segmentsError } = await supabase
      .from("transcript_segments")
      .select("segment_index, start_sec, end_sec, text_raw")
      .eq("transcript_id", transcriptId)
      .order("segment_index", { ascending: true });

    if (segmentsError) {
      console.error("[transcript translate] segments query error:", segmentsError);
      return NextResponse.json({ error: "Failed to load transcript segments" }, { status: 500 });
    }

    const englishSegments = (englishSegmentRows ?? []) as EnglishSegmentRow[];

    if (englishSegments.length === 0) {
      return NextResponse.json<TranslateTranscriptResponse>(
        { status: "error", language, translations: [], error: "No transcript segments to translate." },
        { status: 422 }
      );
    }

    // ---- Tier 0: reuse cached translations for this transcript+language ----
    // Skipped entirely when force=true ("Regenerate translation") — every
    // segment is recomputed from scratch and the upsert below overwrites the
    // stale cached rows via onConflict rather than only filling in gaps.
    const { data: cachedRows, error: cacheError } = await supabase
      .from("transcript_translations")
      .select("segment_index, text_translated, source")
      .eq("transcript_id", transcriptId)
      .eq("language", language);

    if (cacheError) {
      console.error("[transcript translate] cache query error:", cacheError);
    }

    const results = new Map<number, { text: string; source: TranslationSource }>();
    if (!force) {
      for (const row of cachedRows ?? []) {
        results.set(row.segment_index, { text: row.text_translated, source: row.source as TranslationSource });
      }
    }
    const cachedSegmentIndexes = new Set(results.keys());

    if (!force && results.size >= englishSegments.length) {
      console.log(`[transcript translate] full cache hit for transcript ${transcriptId} (${language})`);
      return NextResponse.json<TranslateTranscriptResponse>({
        status: "ready",
        language,
        translations: buildResponseSegments(englishSegments, results),
      });
    }

    // ---- Tier 1: YouTube's own captions in the target language ----
    try {
      const targetItems = await YoutubeTranscript.fetchTranscript(videoId, { lang: language });
      if (targetItems && targetItems.length > 0) {
        matchCaptionCuesToSegments(normalizeCues(targetItems), englishSegments, results);
        console.log(
          `[transcript translate] youtube ${language} captions matched ${results.size}/${englishSegments.length} segments`
        );
      }
    } catch (captionErr) {
      console.log(
        `[transcript translate] no ${language} YouTube captions for ${videoId}:`,
        captionErr instanceof Error ? captionErr.message : captionErr
      );
    }

    // ---- Tier 1b: YouTube's server-side auto-translate of an existing track ----
    if (results.size < englishSegments.length) {
      try {
        const translatedItems = await fetchYoutubeTranslatedCaptions(videoId, language);
        if (translatedItems && translatedItems.length > 0) {
          matchCaptionCuesToSegments(normalizeCues(translatedItems), englishSegments, results);
          console.log(
            `[transcript translate] youtube tlang=${language} auto-translate matched ${results.size}/${englishSegments.length} segments`
          );
        }
      } catch (tlangErr) {
        console.log(
          `[transcript translate] youtube tlang=${language} auto-translate failed for ${videoId}:`,
          tlangErr instanceof Error ? tlangErr.message : tlangErr
        );
      }
    }

    // ---- Tier 2: free, no-API-key translation library (best effort) ----
    const afterTier1Missing = englishSegments.filter((s) => !results.has(s.segment_index));
    let freeLibraryBlocked = false;
    for (const seg of afterTier1Missing) {
      if (freeLibraryBlocked) break;
      try {
        const { text } = await translate(seg.text_raw, { to: language });
        if (text) results.set(seg.segment_index, { text, source: "free_library" });
      } catch (err) {
        console.warn(
          "[transcript translate] free translation library failed (likely rate-limited); falling back to Gemini for the rest:",
          err instanceof Error ? err.message : err
        );
        freeLibraryBlocked = true;
      }
    }

    // ---- Tier 3: Gemini fallback for anything still missing ----
    const finalMissing = englishSegments.filter((s) => !results.has(s.segment_index));
    if (finalMissing.length > 0) {
      const apiKey = process.env.GEMINI_API_KEY;
      const quota = apiKey ? await checkGeminiQuota() : null;
      if (!apiKey) {
        console.error("[transcript translate] GEMINI_API_KEY not set; cannot translate remaining segments");
      } else if (!quota?.allowed) {
        // Same shared budget as /api/ai/explain — skip this tier rather than
        // failing the whole request; whatever tiers 1-2 already found still
        // gets returned below.
        console.warn(`[transcript translate] skipping Gemini tier — quota exceeded (${quota?.reason})`);
      } else {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
          model: GEMINI_MODEL_NAME,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: TRANSLATION_RESPONSE_SCHEMA,
          },
        });
        const prompt = buildTranslationPrompt(
          finalMissing.map((s) => s.text_raw),
          language
        );

        let translated: Map<number, string> | null = null;
        for (let attempt = 0; attempt < 2 && !translated; attempt++) {
          let rawText: string;
          try {
            const result = await Promise.race([
              model.generateContent(prompt),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Gemini translation timed out")), GEMINI_TIMEOUT_MS)
              ),
            ]);
            rawText = result.response.text().trim();
          } catch (geminiErr) {
            console.error("[transcript translate] Gemini translation error:", geminiErr);
            break;
          }

          try {
            const jsonStr = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/, "");
            const parsed: unknown = JSON.parse(jsonStr);
            const byIndex = indexTaggedTranslations(parsed, finalMissing.length);
            if (byIndex) {
              translated = byIndex;
            } else {
              console.warn(
                `[transcript translate] Gemini returned unexpected/misaligned shape on attempt ${attempt + 1}:`,
                rawText
              );
            }
          } catch {
            console.warn(
              `[transcript translate] failed to parse Gemini response on attempt ${attempt + 1}:`,
              rawText
            );
          }
        }

        if (translated) {
          finalMissing.forEach((seg, i) => {
            const text = translated!.get(i + 1);
            if (typeof text === "string" && text.trim()) {
              results.set(seg.segment_index, { text: text.trim(), source: "gemini" });
            }
          });
        } else {
          console.error(
            `[transcript translate] giving up on Gemini translation for ${finalMissing.length} segment(s) after retry`
          );
        }
      }
    }

    if (results.size === 0) {
      return NextResponse.json<TranslateTranscriptResponse>(
        { status: "error", language, translations: [], error: "Unable to translate this transcript right now." },
        { status: 502 }
      );
    }

    // Persist newly-produced translations (cached ones are already stored)
    const newRows = Array.from(results.entries())
      .filter(([segmentIndex]) => !cachedSegmentIndexes.has(segmentIndex))
      .map(([segmentIndex, { text, source }]) => ({
        transcript_id: transcriptId,
        segment_index: segmentIndex,
        language,
        text_translated: text,
        source,
      }));

    if (newRows.length > 0) {
      const { error: upsertError } = await supabase
        .from("transcript_translations")
        .upsert(newRows, { onConflict: "transcript_id,segment_index,language" });
      if (upsertError) {
        console.error("[transcript translate] upsert error:", upsertError);
      }
    }

    console.log(
      `[transcript translate] transcript=${transcriptId} language=${language} translated=${results.size}/${englishSegments.length}`
    );

    return NextResponse.json<TranslateTranscriptResponse>({
      status: "ready",
      language,
      translations: buildResponseSegments(englishSegments, results),
    });
  } catch (err) {
    console.error("[transcript translate] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Fills in `results` for each English segment whose time window overlaps
 * one or more of the target-language caption cues, joining the overlapping
 * cues' text.
 *
 * Matches against raw, un-merged cues (a few words each) rather than
 * mergeIntoSentences' output. Sentence boundaries don't translate 1:1
 * across languages — a Vietnamese sentence built from mergeIntoSentences
 * often spans a different, unrelated stretch of time than the English
 * sentence it happens to overlap, so matching at that granularity was
 * concatenating several EN segments' worth of Vietnamese text onto a single
 * segment. Raw cues stay tied to the original audio's timing (YouTube's
 * tlang auto-translate swaps each cue's text in place without re-timing it),
 * so overlap at that level tracks much more precisely to each EN segment's
 * actual window.
 */
function matchCaptionCuesToSegments(
  cues: { text: string; startSec: number; endSec: number }[],
  englishSegments: EnglishSegmentRow[],
  results: Map<number, { text: string; source: TranslationSource }>
): void {
  for (const enSeg of englishSegments) {
    if (results.has(enSeg.segment_index)) continue;
    const overlapping = cues.filter((c) => c.endSec > enSeg.start_sec && c.startSec < enSeg.end_sec);
    if (overlapping.length > 0) {
      results.set(enSeg.segment_index, {
        text: overlapping.map((c) => c.text).join(" "),
        source: "youtube_captions",
      });
    }
  }
}

function buildResponseSegments(
  englishSegments: EnglishSegmentRow[],
  results: Map<number, { text: string; source: TranslationSource }>
): TranslationSegment[] {
  return englishSegments
    .filter((s) => results.has(s.segment_index))
    .map((s) => {
      const entry = results.get(s.segment_index)!;
      return { segmentIndex: s.segment_index, textTranslated: entry.text, source: entry.source };
    });
}

function buildTranslationPrompt(sentences: string[], language: string): string {
  const languageName = language === "vi" ? "Vietnamese" : language;
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `Translate each of the following numbered English sentences into natural, conversational ${languageName}. Translate every sentence independently: never merge two sentences into a single translation, never split one sentence into multiple translations, and never skip a sentence — even when adjacent sentences are short or closely related in meaning. Respond with a raw JSON array (no markdown fences) of exactly ${sentences.length} objects, one per input sentence, each shaped as {"index": <the sentence's number above>, "translation": "..."}, in any order.

${numbered}`;
}

/**
 * Validates that a Gemini translation response is a complete, non-duplicated
 * set of {index, translation} pairs covering 1..count exactly, and returns
 * it as a Map keyed by index. Returns null on any mismatch (wrong shape,
 * duplicate/missing/out-of-range index) so the caller retries instead of
 * trusting a response that may have silently merged sentences together —
 * see TRANSLATION_RESPONSE_SCHEMA for why this matters more than a plain
 * positional array.
 */
function indexTaggedTranslations(parsed: unknown, count: number): Map<number, string> | null {
  if (!Array.isArray(parsed) || parsed.length !== count) return null;
  const byIndex = new Map<number, string>();
  for (const item of parsed) {
    const index = (item as { index?: unknown } | null)?.index;
    const translation = (item as { translation?: unknown } | null)?.translation;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > count ||
      typeof translation !== "string" ||
      byIndex.has(index)
    ) {
      return null;
    }
    byIndex.set(index, translation);
  }
  return byIndex.size === count ? byIndex : null;
}
