import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLegacyBridgeError } from "@/lib/supabase/legacyBridgeErrors";

interface RestartSessionRequest {
  videoId: string;
  sessionId?: string;
}

// Phase 2: delegates to fn_legacy_restart_round (migration 035), called
// via the caller's own RLS-respecting client — identical behavior to the
// previous raw .update() (abandons the active round(s) for this
// user/video, optionally scoped to one sessionId; does not itself create a
// new round), now gate-aware (write_gate_paused -> 503). See
// supabase/PHASE2_RUNBOOK.md.
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

    const { data, error } = await supabase.rpc("fn_legacy_restart_round", {
      p_youtube_video_id: videoId,
      p_session_id: sessionId ?? null,
    });

    if (error || !data) {
      return mapLegacyBridgeError(error, "Failed to restart session");
    }

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("[session/restart] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
