import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit, checkGeminiQuota } from "@/lib/rateLimit";
import { GEMINI_MODEL_NAME } from "@/lib/gemini";
import type { VocabHighlightsRequest, VocabHighlightsResponse, VocabHighlightSegment } from "@/lib/types";

const GEMINI_TIMEOUT_MS = 20_000;

const HIGHLIGHT_RESPONSE_SCHEMA = {
  type: SchemaType.ARRAY,
  items: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
} as const;

interface SegmentRow {
  segment_index: number;
  text_raw: string;
}

/**
 * Picks 0-3 difficult words/phrases per sentence for the Script tab's
 * underline highlighting, via one batched Gemini call for the whole
 * transcript — never per-segment, never per-user. Results are cached
 * permanently in transcript_vocab_highlights (keyed by transcript_id), so a
 * given video costs the shared Gemini quota (see rateLimit.ts — 5 req/min,
 * 20 req/day, for the entire app) exactly once, ever.
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "transcript/vocab-highlights", {
    limit: 5,
    windowMs: 60_000,
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body: VocabHighlightsRequest = await request.json();
    const { transcriptId } = body;

    if (!transcriptId) {
      return NextResponse.json({ error: "transcriptId is required" }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: segmentRows, error: segmentsError } = await supabase
      .from("transcript_segments")
      .select("segment_index, text_raw")
      .eq("transcript_id", transcriptId)
      .order("segment_index", { ascending: true });

    if (segmentsError) {
      console.error("[vocab-highlights] segments query error:", segmentsError);
      return NextResponse.json({ error: "Failed to load transcript segments" }, { status: 500 });
    }

    const segments = (segmentRows ?? []) as SegmentRow[];
    if (segments.length === 0) {
      return NextResponse.json<VocabHighlightsResponse>(
        { status: "error", highlights: [], error: "No transcript segments to analyze." },
        { status: 422 }
      );
    }

    // ---- Cache check ----
    const { data: cachedRows, error: cacheError } = await supabase
      .from("transcript_vocab_highlights")
      .select("segment_index, phrases")
      .eq("transcript_id", transcriptId);

    if (cacheError) {
      console.error("[vocab-highlights] cache query error:", cacheError);
    }

    const results = new Map<number, string[]>();
    for (const row of cachedRows ?? []) {
      results.set(row.segment_index, Array.isArray(row.phrases) ? row.phrases : []);
    }

    if (results.size >= segments.length) {
      console.log(`[vocab-highlights] full cache hit for transcript ${transcriptId}`);
      return NextResponse.json<VocabHighlightsResponse>({
        status: "ready",
        highlights: buildResponseSegments(segments, results),
      });
    }

    // ---- Gemini for whatever's missing ----
    const missing = segments.filter((s) => !results.has(s.segment_index));
    const apiKey = process.env.GEMINI_API_KEY;
    const quota = apiKey ? await checkGeminiQuota() : null;

    if (!apiKey) {
      console.error("[vocab-highlights] GEMINI_API_KEY not set; cannot compute highlights");
    } else if (!quota?.allowed) {
      console.warn(`[vocab-highlights] skipping Gemini — quota exceeded (${quota?.reason})`);
    } else {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL_NAME,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: HIGHLIGHT_RESPONSE_SCHEMA,
        },
      });
      const prompt = buildHighlightPrompt(missing.map((s) => s.text_raw));

      let picked: string[][] | null = null;
      for (let attempt = 0; attempt < 2 && !picked; attempt++) {
        let rawText: string;
        try {
          const result = await Promise.race([
            model.generateContent(prompt),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Gemini vocab-highlight timed out")), GEMINI_TIMEOUT_MS)
            ),
          ]);
          rawText = result.response.text().trim();
        } catch (geminiErr) {
          console.error("[vocab-highlights] Gemini error:", geminiErr);
          break;
        }

        try {
          const jsonStr = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/, "");
          const parsed: unknown = JSON.parse(jsonStr);
          if (Array.isArray(parsed) && parsed.length === missing.length) {
            picked = parsed as string[][];
          } else {
            console.warn(`[vocab-highlights] unexpected shape on attempt ${attempt + 1}:`, rawText);
          }
        } catch {
          console.warn(`[vocab-highlights] failed to parse response on attempt ${attempt + 1}:`, rawText);
        }
      }

      if (picked) {
        missing.forEach((seg, i) => {
          const candidates = picked![i];
          if (!Array.isArray(candidates)) {
            results.set(seg.segment_index, []);
            return;
          }
          // Defensive: only keep phrases Gemini didn't hallucinate — each must
          // actually occur in the sentence, so the client can locate it via
          // substring match to underline it.
          const lowerText = seg.text_raw.toLowerCase();
          const verified = candidates
            .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
            .map((p) => p.trim())
            .filter((p) => lowerText.includes(p.toLowerCase()));
          results.set(seg.segment_index, verified);
        });
      } else {
        console.error(`[vocab-highlights] giving up on Gemini for ${missing.length} segment(s) after retry`);
      }
    }

    // Persist newly-computed rows (including empty-array "nothing stood out"
    // results, so this transcript is never re-sent to Gemini again).
    const newRows = Array.from(results.entries())
      .filter(([segmentIndex]) => !(cachedRows ?? []).some((r) => r.segment_index === segmentIndex))
      .map(([segmentIndex, phrases]) => ({
        transcript_id: transcriptId,
        segment_index: segmentIndex,
        phrases,
      }));

    if (newRows.length > 0) {
      const { error: upsertError } = await supabase
        .from("transcript_vocab_highlights")
        .upsert(newRows, { onConflict: "transcript_id,segment_index" });
      if (upsertError) {
        console.error("[vocab-highlights] upsert error:", upsertError);
      }
    }

    console.log(
      `[vocab-highlights] transcript=${transcriptId} computed=${results.size}/${segments.length}`
    );

    return NextResponse.json<VocabHighlightsResponse>({
      status: "ready",
      highlights: buildResponseSegments(segments, results),
    });
  } catch (err) {
    console.error("[vocab-highlights] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

function buildResponseSegments(
  segments: SegmentRow[],
  results: Map<number, string[]>
): VocabHighlightSegment[] {
  return segments
    .filter((s) => results.has(s.segment_index))
    .map((s) => ({ segmentIndex: s.segment_index, phrases: results.get(s.segment_index)! }));
}

function buildHighlightPrompt(sentences: string[]): string {
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `You are helping an intermediate (B1-B2) English learner. For each numbered sentence below, pick 0 to 3 words or short phrases (at most 4 words each) that this learner would likely find difficult or worth studying — advanced vocabulary, idioms, phrasal verbs, or uncommon collocations. Skip proper nouns/names and basic everyday vocabulary. Copy each phrase EXACTLY as it appears in the sentence (same words, same casing) so it can be located by an exact substring match. Respond with a raw JSON array (no markdown fences) of arrays of strings, one array per input sentence in the same order, using an empty array when nothing in that sentence stands out.

${numbered}`;
}
