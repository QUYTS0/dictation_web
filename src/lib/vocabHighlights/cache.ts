import type { SupabaseClient } from "@supabase/supabase-js";
import type { LearningLevel } from "./publicConfig";
import type { PublicHighlightPhrase, HighlightGenerationStatus } from "./types";

interface HighlightRow {
  segment_index: number;
  phrases: PublicHighlightPhrase[];
  status: "complete" | "empty";
  transcript_text_hash: string | null;
  azure_used: boolean;
}

export interface CachedSegmentResult {
  segmentIndex: number;
  phrases: PublicHighlightPhrase[];
  status: "complete" | "empty";
  azureUsed: boolean;
}

/**
 * Reads cached rows for (transcript_id, learning_level, pipeline_version)
 * and drops any row whose stored transcript_text_hash doesn't match the
 * segment's current text — a text-hash mismatch must never return stale
 * highlights, even if the other three key columns match (defensive: today
 * transcript/generate already wipes this table wholesale on regenerate, so
 * this case is not expected to occur in practice, but is still validated).
 * A row with a null hash (legacy Gemini-era backfill) never matches any
 * freshly computed hash, so legacy rows are automatically treated as stale.
 */
export async function readCachedHighlights(
  supabase: SupabaseClient,
  transcriptId: string,
  learningLevel: LearningLevel,
  pipelineVersion: string,
  expectedHashBySegment: Map<number, string>
): Promise<Map<number, CachedSegmentResult>> {
  const { data, error } = await supabase
    .from("transcript_vocab_highlights")
    .select("segment_index, phrases, status, transcript_text_hash, azure_used")
    .eq("transcript_id", transcriptId)
    .eq("learning_level", learningLevel)
    .eq("pipeline_version", pipelineVersion);

  if (error) {
    console.error("[vocabHighlights/cache] read error:", error);
    return new Map();
  }

  const result = new Map<number, CachedSegmentResult>();
  for (const row of (data ?? []) as HighlightRow[]) {
    const expectedHash = expectedHashBySegment.get(row.segment_index);
    if (!expectedHash || row.transcript_text_hash !== expectedHash) continue;
    result.set(row.segment_index, {
      segmentIndex: row.segment_index,
      phrases: row.phrases ?? [],
      status: row.status,
      azureUsed: row.azure_used,
    });
  }
  return result;
}

export interface HighlightRowToWrite {
  segmentIndex: number;
  phrases: PublicHighlightPhrase[];
  status: Exclude<HighlightGenerationStatus, "failed">;
  transcriptTextHash: string;
  azureUsed: boolean;
  candidateCounts: Record<string, number>;
}

/**
 * Upserts only successfully-computed rows. A segment whose generation
 * failed this run is simply never passed here — it stays absent from the
 * upsert, exactly like the legacy Gemini-timeout behavior, so a future
 * request retries it automatically. "failed" is never written to this
 * table (see types.ts's HighlightGenerationStatus).
 */
export async function upsertHighlightRows(
  supabase: SupabaseClient,
  transcriptId: string,
  learningLevel: LearningLevel,
  pipelineVersion: string,
  rows: HighlightRowToWrite[]
): Promise<void> {
  if (rows.length === 0) return;

  const { error } = await supabase.from("transcript_vocab_highlights").upsert(
    rows.map((r) => ({
      transcript_id: transcriptId,
      segment_index: r.segmentIndex,
      learning_level: learningLevel,
      pipeline_version: pipelineVersion,
      phrases: r.phrases,
      status: r.status,
      transcript_text_hash: r.transcriptTextHash,
      azure_used: r.azureUsed,
      candidate_counts: r.candidateCounts,
      generated_at: new Date().toISOString(),
    })),
    { onConflict: "transcript_id,segment_index,learning_level,pipeline_version" }
  );

  if (error) {
    console.error("[vocabHighlights/cache] upsert error:", error);
  }
}
