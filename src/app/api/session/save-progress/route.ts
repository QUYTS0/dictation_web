import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapPracticeWriteError } from "@/lib/supabase/practiceWriteErrors";
import type { SaveProgressRequest, SaveProgressResponse } from "@/lib/types";

// Saves the practice checkpoint (sentence + playhead) and, on first touch,
// creates the round: fn_update_resume_position when the round is known,
// fn_create_or_get_active_round otherwise (the server resolves the current
// transcript and rejects a stale client revision atomically).
//
// Completion, counters and round identity are owned by the database
// (Phase 3). The deprecated fields an old browser tab may still send —
// accuracy, totalAttempts, status — are accepted and IGNORED: they never
// reach the database, and status "completed" never completes a round (the
// tab still gets its checkpoint saved). Phase 8 removed the pre-cutover
// fn_legacy_save_progress branch; PRACTICE_WRITE_PATH is no longer read.
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
      status,
    } = body;

    if (!youtubeVideoId) {
      return NextResponse.json({ error: "youtubeVideoId is required" }, { status: 400 });
    }

    if (!Number.isInteger(currentSegmentIndex) || currentSegmentIndex < 0) {
      return NextResponse.json({ error: "currentSegmentIndex must be a non-negative integer" }, { status: 400 });
    }
    const timeSec =
      typeof videoCurrentTimeSec === "number" && Number.isFinite(videoCurrentTimeSec) && videoCurrentTimeSec >= 0
        ? videoCurrentTimeSec
        : null;
    if (status !== undefined && status !== "active") {
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
    const result = data as { roundId: string; roundStatus: string; created?: boolean };
    // Starting a video's first round puts it in the Library (Phase 6) — for
    // videos opened without Add Video (a shared or typed link). Implicit:
    // never re-adds a video the user removed.
    if (result.created) {
      const { error: membershipError } = await supabase.rpc("fn_library_add_video", {
        p_youtube_video_id: youtubeVideoId,
        p_explicit: false,
      });
      if (membershipError) console.error("[save-progress] library membership error:", membershipError);
    }
    return NextResponse.json<SaveProgressResponse>({ sessionId: result.roundId, status: result.roundStatus });
  } catch (err) {
    console.error("[save-progress] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
