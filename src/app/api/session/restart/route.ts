import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLegacyBridgeError } from "@/lib/supabase/legacyBridgeErrors";
import { mapPracticeWriteError } from "@/lib/supabase/practiceWriteErrors";
import { getPracticeWritePath } from "@/lib/practice/writePath";

interface RestartSessionRequest {
  videoId: string;
  /** The round the client is restarting — makes a retried request return
   *  the round the first attempt created instead of restarting again. */
  sessionId?: string;
}

// authoritative: fn_restart_round abandons the active round (history is
// kept), closes the open study session, and creates the next round pinned
// to the current ready transcript — all in one transaction. The response
// carries the new round so the client can pin to it immediately.
// legacy: the Phase 2 bridge (abandon only; the next save creates a round).
export async function POST(request: NextRequest) {
  try {
    const body: RestartSessionRequest = await request.json();
    const { videoId, sessionId } = body;

    if (!videoId) {
      return NextResponse.json({ error: "videoId is required" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    if (getPracticeWritePath() === "legacy") {
      const { data, error } = await supabase.rpc("fn_legacy_restart_round", {
        p_youtube_video_id: videoId,
        p_session_id: sessionId ?? null,
      });
      if (error || !data) return mapLegacyBridgeError(error, "Failed to restart session");
      return NextResponse.json({ status: "ok" });
    }

    const { data, error } = await supabase.rpc("fn_restart_round", {
      p_youtube_video_id: videoId,
      p_expected_round_id: sessionId ?? null,
    });
    if (error || !data) return mapPracticeWriteError(supabase, error, "Failed to restart session");
    const result = data as { roundId: string; transcriptId: string; created: boolean; roundNumber: number };
    return NextResponse.json({
      status: "ok",
      sessionId: result.roundId,
      transcriptId: result.transcriptId,
      created: result.created,
      roundNumber: result.roundNumber,
    });
  } catch (err) {
    console.error("[session/restart] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
