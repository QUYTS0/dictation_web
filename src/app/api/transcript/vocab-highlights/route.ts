import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import type { VocabHighlightsRequest, VocabHighlightsResponse, VocabHighlightSegment } from "@/lib/types";
import { DEFAULT_LEARNING_LEVEL, type LearningLevel } from "@/lib/vocabHighlights/publicConfig";
import { PIPELINE_VERSION } from "@/lib/vocabHighlights/config";
import { hashSegmentText } from "@/lib/vocabHighlights/textHash";
import { readCachedHighlights, upsertHighlightRows } from "@/lib/vocabHighlights/cache";
import { runPipeline, type PipelineSegmentInput } from "@/lib/vocabHighlights/pipeline";

// Vercel Hobby hard-caps a function's total run time at 60s regardless of
// this file's own settings — the pipeline's own ROUTE_TIME_BUDGET_MS (45s,
// see config.ts) leaves margin under this for the surrounding DB queries and
// response serialization, same rationale the legacy Gemini implementation
// used for its own timeout.
export const maxDuration = 60;

interface SegmentRow {
  segment_index: number;
  text_raw: string;
}

const LEARNING_LEVEL_VALUES: LearningLevel[] = ["A1", "A2", "B1", "B2", "C1"];

/**
 * Deterministic, mostly-local vocabulary-highlight generation: winkNLP +
 * EFLLex + SUBTLEX + Open English WordNet, with optional Azure Key Phrase
 * Extraction enrichment (disabled by default — AZURE_KEY_PHRASE_ENABLED).
 * No Gemini call exists anywhere in this path — see
 * src/__tests__/vocabHighlights/no-gemini-import.test.ts.
 *
 * Cache identity is (transcript_id, segment_index, learning_level,
 * pipeline_version) plus a read-time transcript_text_hash check — see
 * src/lib/vocabHighlights/cache.ts.
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "transcript/vocab-highlights", {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body: VocabHighlightsRequest = await request.json();
    const { transcriptId, force } = body;
    const learningLevel: LearningLevel = LEARNING_LEVEL_VALUES.includes(body.learningLevel as LearningLevel)
      ? (body.learningLevel as LearningLevel)
      : DEFAULT_LEARNING_LEVEL;

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

    const expectedHashBySegment = new Map(segments.map((s) => [s.segment_index, hashSegmentText(s.text_raw)]));

    const cached = force
      ? new Map()
      : await readCachedHighlights(supabase, transcriptId, learningLevel, PIPELINE_VERSION, expectedHashBySegment);

    const missing: PipelineSegmentInput[] = segments
      .filter((s) => !cached.has(s.segment_index))
      .map((s) => ({ segmentIndex: s.segment_index, textRaw: s.text_raw }));

    let incomplete = false;
    const finalBySegment = new Map<number, VocabHighlightSegment>();

    for (const [segmentIndex, row] of cached) {
      finalBySegment.set(segmentIndex, { segmentIndex, phrases: row.phrases });
    }

    if (missing.length > 0) {
      const result = await runPipeline(missing, learningLevel);

      const rowsToWrite = Array.from(result.bySegment.entries()).map(([segmentIndex, r]) => ({
        segmentIndex,
        phrases: r.phrases,
        status: r.status,
        transcriptTextHash: r.transcriptTextHash,
        azureUsed: r.azureUsed,
        candidateCounts: r.candidateCounts,
      }));
      await upsertHighlightRows(supabase, transcriptId, learningLevel, PIPELINE_VERSION, rowsToWrite);

      for (const [segmentIndex, r] of result.bySegment) {
        finalBySegment.set(segmentIndex, { segmentIndex, phrases: r.phrases });
      }

      if (result.incompleteSegmentIndexes.length > 0) {
        incomplete = true;
        // Force-regeneration must not erase previously-valid highlights for
        // a segment that failed to recompute this round — fall back to
        // whatever was cached before, if anything (a single re-read, not
        // one query per incomplete segment).
        if (force) {
          const previousValid = await readCachedHighlights(
            supabase,
            transcriptId,
            learningLevel,
            PIPELINE_VERSION,
            expectedHashBySegment
          );
          for (const segmentIndex of result.incompleteSegmentIndexes) {
            const previous = previousValid.get(segmentIndex);
            if (previous) finalBySegment.set(segmentIndex, { segmentIndex, phrases: previous.phrases });
          }
        }
      }
    }

    const highlights = segments
      .filter((s) => finalBySegment.has(s.segment_index))
      .map((s) => finalBySegment.get(s.segment_index)!);

    console.log(
      `[vocab-highlights] transcript=${transcriptId} level=${learningLevel} pipelineVersion=${PIPELINE_VERSION} ` +
        `cacheHits=${cached.size} computed=${missing.length} incomplete=${incomplete}`
    );

    return NextResponse.json<VocabHighlightsResponse>({
      status: "ready",
      highlights,
      ...(incomplete ? { incomplete: true } : {}),
    });
  } catch (err) {
    console.error("[vocab-highlights] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
