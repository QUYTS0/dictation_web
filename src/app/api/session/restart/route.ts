import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface RestartSessionRequest {
  videoId: string;
  sessionId?: string;
}

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

    let query = supabase
      .from("learning_sessions")
      .update({
        status: "abandoned",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)
      .eq("youtube_video_id", videoId)
      .eq("status", "active");

    if (sessionId) {
      query = query.eq("id", sessionId);
    }

    const { error } = await query;
    if (error) {
      console.error("[session/restart] update error:", error);
      return NextResponse.json({ error: "Failed to restart session" }, { status: 500 });
    }

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("[session/restart] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

