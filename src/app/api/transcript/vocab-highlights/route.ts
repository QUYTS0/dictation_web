import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit, checkGeminiQuota } from "@/lib/rateLimit";
import { GEMINI_MODEL_NAME } from "@/lib/gemini";
import type {
  VocabHighlightsRequest,
  VocabHighlightsResponse,
  VocabHighlightSegment,
  VocabHighlightPhrase,
} from "@/lib/types";

// Vercel Hobby hard-caps a function's total run time at 60s regardless of
// this file's own settings — maxDuration below can't exceed it. Per-batch
// timeout is kept well under that ceiling (not equal to it) so there's still
// room for the surrounding DB queries/upsert and for other slow chunks of
// the request to fail without slamming into the platform's own hard kill,
// which — unlike our own timeout — doesn't fail gracefully with a proper
// error/log this route can react to.
export const maxDuration = 60;
const GEMINI_TIMEOUT_MS = 45_000;
const HIGHLIGHT_TRANSLATION_LANGUAGE = "Vietnamese";
// Batches Gemini calls instead of sending the whole transcript in one prompt
// — a long video (hundreds of segments) in a single call reliably blew past
// the old, shorter GEMINI_TIMEOUT_MS and gave up entirely, leaving zero
// highlights. Each batch still costs its own unit of the shared Gemini
// quota (rateLimit.ts), so a very long transcript may only get partway
// through per request — whatever's left over just stays "missing" and gets
// picked up by the next request for this transcript (e.g. the next time
// someone opens the Script tab), same as any other not-yet-computed
// segment. Sized to comfortably fit a few batches within GEMINI_TIMEOUT_MS's
// larger budget rather than one all-or-nothing call for the whole video.
const VOCAB_HIGHLIGHT_BATCH_SIZE = 80;

const HIGHLIGHT_RESPONSE_SCHEMA: Schema = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.ARRAY,
    items: {
      type: SchemaType.OBJECT,
      properties: {
        phrase: { type: SchemaType.STRING },
        translation: { type: SchemaType.STRING },
      },
      required: ["phrase", "translation"],
    },
  },
};

interface SegmentRow {
  segment_index: number;
  text_raw: string;
}

interface RawPickedPhrase {
  phrase: string;
  translation: string;
}

/**
 * Picks 0-3 difficult words/phrases per sentence for the Script tab's
 * underline highlighting, via batched Gemini calls (VOCAB_HIGHLIGHT_BATCH_SIZE
 * segments each) covering the whole transcript — never per-segment, never
 * per-user. Each call also asks Gemini for its phrases' in-context
 * translations, since it's already reading the sentence to pick the phrase —
 * a free addition to that call's output rather than a separate translation
 * request per phrase. Results are cached permanently in
 * transcript_vocab_highlights (keyed by transcript_id), so a given segment
 * costs the shared Gemini quota (see rateLimit.ts — 5 req/min, 20 req/day,
 * for the entire app) exactly once, ever — a long transcript may just take a
 * few requests to fully fill in as quota allows.
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

    const results = new Map<number, VocabHighlightPhrase[]>();
    for (const row of cachedRows ?? []) {
      results.set(row.segment_index, normalizeCachedPhrases(row.phrases));
    }

    if (results.size >= segments.length) {
      console.log(`[vocab-highlights] full cache hit for transcript ${transcriptId}`);
      return NextResponse.json<VocabHighlightsResponse>({
        status: "ready",
        highlights: buildResponseSegments(segments, results),
      });
    }

    // ---- Gemini for whatever's missing, in size-bounded batches ----
    const missing = segments.filter((s) => !results.has(s.segment_index));
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error("[vocab-highlights] GEMINI_API_KEY not set; cannot compute highlights");
    } else {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL_NAME,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: HIGHLIGHT_RESPONSE_SCHEMA,
        },
      });

      for (let batchStart = 0; batchStart < missing.length; batchStart += VOCAB_HIGHLIGHT_BATCH_SIZE) {
        const batch = missing.slice(batchStart, batchStart + VOCAB_HIGHLIGHT_BATCH_SIZE);

        // Checked per batch (not once upfront) — each batch is its own
        // Gemini call and spends its own unit of the shared budget.
        const quota = await checkGeminiQuota();
        if (!quota.allowed) {
          console.warn(
            `[vocab-highlights] stopping — quota exceeded (${quota.reason}); ${missing.length - batchStart} segment(s) left for a future request`
          );
          break;
        }

        const prompt = buildHighlightPrompt(batch.map((s) => s.text_raw));

        let picked: RawPickedPhrase[][] | null = null;
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
            if (Array.isArray(parsed) && parsed.length === batch.length) {
              picked = parsed as RawPickedPhrase[][];
            } else {
              console.warn(`[vocab-highlights] unexpected shape on attempt ${attempt + 1}:`, rawText);
            }
          } catch {
            console.warn(`[vocab-highlights] failed to parse response on attempt ${attempt + 1}:`, rawText);
          }
        }

        if (picked) {
          batch.forEach((seg, i) => {
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
              .filter(
                (p): p is RawPickedPhrase =>
                  typeof p?.phrase === "string" && p.phrase.trim().length > 0 && typeof p?.translation === "string"
              )
              .map((p) => ({ phrase: p.phrase.trim(), translation: p.translation.trim() }))
              .filter((p) => lowerText.includes(p.phrase.toLowerCase()) && p.translation.length > 0);
            results.set(seg.segment_index, verified);
          });
        } else {
          console.error(`[vocab-highlights] giving up on Gemini for batch of ${batch.length} segment(s) after retry`);
        }
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

/**
 * The `phrases` column predates per-phrase translations, so older cached
 * rows hold plain strings rather than {phrase, translation} objects.
 * Normalize both shapes here rather than migrating/re-fetching old rows —
 * a legacy entry just comes back with translation: null, and the client
 * falls back to its own preview lookup for those.
 */
function normalizeCachedPhrases(raw: unknown): VocabHighlightPhrase[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): VocabHighlightPhrase | null => {
      if (typeof entry === "string") {
        return entry.trim() ? { phrase: entry.trim(), translation: null } : null;
      }
      if (entry && typeof entry === "object" && typeof (entry as { phrase?: unknown }).phrase === "string") {
        const phrase = (entry as { phrase: string }).phrase.trim();
        const translationRaw = (entry as { translation?: unknown }).translation;
        if (!phrase) return null;
        return { phrase, translation: typeof translationRaw === "string" && translationRaw.trim() ? translationRaw.trim() : null };
      }
      return null;
    })
    .filter((p): p is VocabHighlightPhrase => p !== null);
}

function buildResponseSegments(
  segments: SegmentRow[],
  results: Map<number, VocabHighlightPhrase[]>
): VocabHighlightSegment[] {
  return segments
    .filter((s) => results.has(s.segment_index))
    .map((s) => ({ segmentIndex: s.segment_index, phrases: results.get(s.segment_index)! }));
}

function buildHighlightPrompt(sentences: string[]): string {
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `You are helping an intermediate (B1-B2) English learner. For each numbered sentence below, pick 0 to 3 words or short phrases (at most 4 words each) that this learner would likely find difficult or worth studying — advanced vocabulary, idioms, phrasal verbs, or uncommon collocations. Skip proper nouns/names and basic everyday vocabulary. For each one, give:
- "phrase": copied EXACTLY as it appears in the sentence (same words, same casing) so it can be located by an exact substring match.
- "translation": its ${HIGHLIGHT_TRANSLATION_LANGUAGE} translation as it is used in that specific sentence (not just a dictionary/out-of-context translation).

Respond with a raw JSON array (no markdown fences) of arrays of {phrase, translation} objects, one array per input sentence in the same order, using an empty array when nothing in that sentence stands out.

${numbered}`;
}
