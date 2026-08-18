import { NextRequest, NextResponse } from "next/server";
import { YoutubeTranscript } from "youtube-transcript";
import { translate } from "@vitalets/google-translate-api";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { mergeIntoSentences } from "@/lib/utils/segment";
import { GEMINI_MODEL_NAME } from "@/lib/gemini";
import type {
  TranslateTranscriptRequest,
  TranslateTranscriptResponse,
  TranslationSegment,
  TranslationSource,
} from "@/lib/types";

const GEMINI_TIMEOUT_MS = 20_000;

const TRANSLATION_RESPONSE_SCHEMA = {
  type: SchemaType.ARRAY,
  items: { type: SchemaType.STRING },
} as const;

interface EnglishSegmentRow {
  segment_index: number;
  start_sec: number;
  end_sec: number;
  text_raw: string;
}

/**
 * Translates a transcript's segments to `language` (default Vietnamese),
 * trying progressively more expensive tiers and caching each result:
 *   1. YouTube's own captions in the target language, if the video has them.
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
    const { videoId, transcriptId, language = "vi" } = body;

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
    const { data: cachedRows, error: cacheError } = await supabase
      .from("transcript_translations")
      .select("segment_index, text_translated, source")
      .eq("transcript_id", transcriptId)
      .eq("language", language);

    if (cacheError) {
      console.error("[transcript translate] cache query error:", cacheError);
    }

    const results = new Map<number, { text: string; source: TranslationSource }>();
    for (const row of cachedRows ?? []) {
      results.set(row.segment_index, { text: row.text_translated, source: row.source as TranslationSource });
    }
    const cachedSegmentIndexes = new Set(results.keys());

    if (results.size >= englishSegments.length) {
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
        const targetSegments = mergeIntoSentences(targetItems);
        for (const enSeg of englishSegments) {
          if (results.has(enSeg.segment_index)) continue;
          const overlapping = targetSegments.filter((t) => {
            const tEnd = t.start + t.duration;
            return tEnd > enSeg.start_sec && t.start < enSeg.end_sec;
          });
          if (overlapping.length > 0) {
            results.set(enSeg.segment_index, {
              text: overlapping.map((t) => t.text).join(" "),
              source: "youtube_captions",
            });
          }
        }
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
      if (!apiKey) {
        console.error("[transcript translate] GEMINI_API_KEY not set; cannot translate remaining segments");
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

        let translated: string[] | null = null;
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
            if (Array.isArray(parsed) && parsed.length === finalMissing.length) {
              translated = parsed as string[];
            } else {
              console.warn(
                `[transcript translate] Gemini returned unexpected shape on attempt ${attempt + 1}:`,
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
            const text = translated![i];
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
  return `Translate the following numbered English sentences into natural, conversational ${languageName}. Respond with a raw JSON array of strings (no markdown fences), in the exact same order, one translated string per input sentence, with no extra commentary.

${numbered}`;
}
