import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLegacyBridgeError } from "@/lib/supabase/legacyBridgeErrors";
import type { SaveProgressRequest, SaveProgressResponse } from "@/lib/types";

// Phase 2: this route's create/update logic now lives in
// fn_legacy_save_progress (migration 035), called via the caller's own
// RLS-respecting client — identical behavior to the previous raw
// .from("learning_sessions") calls (including the transcript-pin
// validation and the concurrent-first-save race handling), with one
// addition: the write is now gate-aware (write_gate_paused -> 503), and
// the race-winner-reuse path also validates the winner's transcript pin
// against this request. See supabase/PHASE2_RUNBOOK.md.
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
      return NextResponse.json(
        { error: "youtubeVideoId is required" },
        { status: 400 }
      );
    }

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

    if (error || !data) {
      return mapLegacyBridgeError(error, "Failed to save session");
    }

    const result = data as { sessionId: string; status: string };
    console.log(`[save-progress] saved session ${result.sessionId} (status=${result.status})`);
    return NextResponse.json<SaveProgressResponse>({
      sessionId: result.sessionId,
      status: result.status,
    });
  } catch (err) {
    console.error("[save-progress] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
