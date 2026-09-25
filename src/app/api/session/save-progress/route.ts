import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLegacyBridgeError } from "@/lib/supabase/legacyBridgeErrors";
import { mapPracticeWriteError } from "@/lib/supabase/practiceWriteErrors";
import { getPracticeWritePath } from "@/lib/practice/writePath";
import type { SaveProgressRequest, SaveProgressResponse } from "@/lib/types";

// Saves the practice checkpoint (sentence + playhead) and, on first touch,
// creates the round. Which database path serves it is fixed per deployment
// (src/lib/practice/writePath.ts):
//   authoritative — fn_update_resume_position when the round is known,
//     fn_create_or_get_active_round otherwise (the server resolves the
//     current transcript and rejects a stale client revision atomically).
//     Client-supplied accuracy/totalAttempts/status are IGNORED: counters
//     and completion are owned by the database. An old tab that still sends
//     status "completed" saves its checkpoint but cannot complete a round.
//   legacy — the Phase 2 bridge (preparation release only).
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const body: SaveProgressRequest = await request.json();
    const {
      sessionId,
      youtubeVideoId,
      transcriptId,
      currentSegmentIndex,
      videoCurrentTimeSec = 0,
      accuracy,
      totalAttempts,
      status = "active",
    } = body;

    if (!youtubeVideoId) {
      return NextResponse.json({ error: "youtubeVideoId is required" }, { status: 400 });
    }

    if (getPracticeWritePath() === "legacy") {
      const { data, error } = await supabase.rpc("fn_legacy_save_progress", {
        p_session_id: sessionId ?? null,
        p_youtube_video_id: youtubeVideoId,
        p_transcript_id: transcriptId ?? null,
        p_current_segment_index: currentSegmentIndex,
        p_video_current_time_sec: videoCurrentTimeSec,
        p_accuracy: accuracy,
        p_total_attempts: totalAttempts,
        p_status: status,
      });
      if (error || !data) return mapLegacyBridgeError(error, "Failed to save session");
      const result = data as { sessionId: string; status: string };
      return NextResponse.json<SaveProgressResponse>({ sessionId: result.sessionId, status: result.status });
    }

    if (!Number.isInteger(currentSegmentIndex) || currentSegmentIndex < 0) {
      return NextResponse.json({ error: "currentSegmentIndex must be a non-negative integer" }, { status: 400 });
    }
    const timeSec =
      typeof videoCurrentTimeSec === "number" && Number.isFinite(videoCurrentTimeSec) && videoCurrentTimeSec >= 0
        ? videoCurrentTimeSec
        : null;
    if (status !== "active") {
      console.log(`[save-progress] ignoring client-supplied status "${status}" (completion is server-owned)`);
    }

    if (sessionId) {
      const { data, error } = await supabase.rpc("fn_update_resume_position", {
        p_round_id: sessionId,
        p_youtube_video_id: youtubeVideoId,
        p_segment_index: currentSegmentIndex,
        p_video_current_time_sec: timeSec,
        p_expected_transcript_id: transcriptId ?? null,
      });
      if (error || !data) return mapPracticeWriteError(supabase, error, "Failed to save session");
      const result = data as { roundId: string; roundStatus: string };
      return NextResponse.json<SaveProgressResponse>({ sessionId: result.roundId, status: result.roundStatus });
    }

    const { data, error } = await supabase.rpc("fn_create_or_get_active_round", {
      p_youtube_video_id: youtubeVideoId,
      p_expected_transcript_id: transcriptId ?? null,
      p_segment_index: currentSegmentIndex,
      p_video_current_time_sec: timeSec,
    });
    if (error || !data) return mapPracticeWriteError(supabase, error, "Failed to save session");
    const result = data as { roundId: string; roundStatus: string };
    return NextResponse.json<SaveProgressResponse>({ sessionId: result.roundId, status: result.roundStatus });
  } catch (err) {
    console.error("[save-progress] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
