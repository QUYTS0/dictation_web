import type { SupabaseClient } from "@supabase/supabase-js";
import type { StudyFlushResult } from "@/lib/practice/listeningTypes";

/**
 * Server side of Phase 5's Listening sync and activity pulses (plan §6.3,
 * §6.3b, §9.6). One RPC — fn_sync_study_activity (039) — does everything in
 * one transaction with the caller's own identity (`auth.uid()`), so callers
 * must pass the cookie-based client from `createClient()`:
 *   1. a batch id this user already recorded is answered from the session
 *      it was recorded under (no side effects) — a retry can never reach
 *      another session;
 *   2. otherwise the batch is attributed by the round it was OBSERVED under
 *      (`roundId`, captured by the client at observation time and
 *      relationship-checked in SQL): the ordinary session rule while that
 *      round is still current and the data is fresh, else the round's last
 *      session, untouched ("late"), or a refusal when there is none.
 * The route never resolves a round or a session itself.
 */

export class StudyActivityError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

export type FlushActivityKind = "listening" | "activity";

export interface SyncStudyActivityInput {
  kind: FlushActivityKind;
  youtubeVideoId: string;
  flushBatchId: string;
  /** The round the observations were made under (null = none). */
  roundId: string | null;
  intervals: Array<{ start: number; end: number }>;
  /** Listening only. */
  transcriptId?: string | null;
  /** Listening only — resume convenience, never feeds coverage. */
  currentPositionSec?: number | null;
  clientTimezone?: string | null;
  /** Seconds since the newest observation in the batch (client-measured). */
  observedAgeSec?: number | null;
}

export async function syncStudyActivity(supabase: SupabaseClient, input: SyncStudyActivityInput): Promise<StudyFlushResult> {
  const { data, error } = await supabase.rpc("fn_sync_study_activity", {
    p_kind: input.kind,
    p_flush_batch_id: input.flushBatchId,
    p_youtube_video_id: input.youtubeVideoId,
    p_round_id: input.roundId,
    p_intervals: input.intervals,
    p_transcript_id: input.transcriptId ?? null,
    p_current_position_sec: input.currentPositionSec ?? null,
    p_client_timezone: input.clientTimezone ?? null,
    p_observed_age_sec: input.observedAgeSec ?? null,
  });
  if (error || !data) {
    const e = error as { message?: string; code?: string } | null;
    throw new StudyActivityError(e?.message || "Couldn't save activity.", e?.code);
  }
  return data as StudyFlushResult;
}
