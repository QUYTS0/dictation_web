import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Thin typed wrappers around the two study-session RPCs granted to
 * `authenticated` in Phase 2 (fn_get_or_create_study_session,
 * fn_flush_study_activity — migration 035). Not called from any route or
 * component yet — Phase 2 only adds the functions and this wrapper; the
 * player/practice hooks are not wired to them until a later phase.
 *
 * Callers must pass the cookie-based (RLS-respecting) client from
 * `createClient()` — these RPCs derive the actor from `auth.uid()` inside
 * the function body.
 */

export interface GetOrCreateStudySessionResult {
  studySessionId: string;
  roundId: string | null;
  created: boolean;
}

export async function getOrCreateStudySession(
  supabase: SupabaseClient,
  youtubeVideoId: string,
  roundId?: string | null
): Promise<GetOrCreateStudySessionResult> {
  const { data, error } = await supabase.rpc("fn_get_or_create_study_session", {
    p_youtube_video_id: youtubeVideoId,
    p_round_id: roundId ?? null,
  });
  if (error || !data) {
    throw new Error(error?.message ?? "fn_get_or_create_study_session returned no data");
  }
  return data as GetOrCreateStudySessionResult;
}

export type FlushActivityKind = "listening" | "activity";

export interface FlushStudyActivityInput {
  kind: FlushActivityKind;
  studySessionId: string;
  /** Client-generated; reused verbatim across network retries of the same buffered batch, regenerated only for genuinely new data. */
  flushBatchId: string;
  youtubeVideoId: string;
  intervals?: Array<{ start: number; end: number }>;
  /** Listening kind only. */
  transcriptId?: string | null;
  /** Listening kind only — the current playhead, for resume convenience (never feeds coverage). */
  currentPositionSec?: number | null;
  clientTimezone?: string | null;
}

export interface FlushStudyActivityResult {
  processed: boolean;
  coverageRatio?: number;
  listenedThrough?: boolean;
  coveredSec?: number;
  lastPositionSec?: number;
  hasHistory?: boolean;
}

export async function flushStudyActivity(
  supabase: SupabaseClient,
  input: FlushStudyActivityInput
): Promise<FlushStudyActivityResult> {
  const { data, error } = await supabase.rpc("fn_flush_study_activity", {
    p_kind: input.kind,
    p_study_session_id: input.studySessionId,
    p_flush_batch_id: input.flushBatchId,
    p_youtube_video_id: input.youtubeVideoId,
    p_intervals: input.intervals ?? [],
    p_transcript_id: input.transcriptId ?? null,
    p_current_position_sec: input.currentPositionSec ?? null,
    p_client_timezone: input.clientTimezone ?? null,
  });
  if (error || !data) {
    throw new Error(error?.message ?? "fn_flush_study_activity returned no data");
  }
  return data as FlushStudyActivityResult;
}
