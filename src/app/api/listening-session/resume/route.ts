import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ResumeListeningSessionResponse } from "@/lib/types";

export async function GET(request: NextRequest) {
  try {
    const videoId = request.nextUrl.searchParams.get("videoId");
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

    // Latest session regardless of status, same reasoning as dictation's
    // session/resume — a completed video should report back as completed
    // rather than looking unseen and spawning a fresh active row.
    const { data, error } = await supabase
      .from("listening_sessions")
      .select("id, video_current_time, updated_at, status")
      .eq("user_id", user.id)
      .eq("youtube_video_id", videoId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("[listening-session/resume] query error:", error);
      return NextResponse.json({ error: "Failed to fetch session" }, { status: 500 });
    }

    const response: ResumeListeningSessionResponse = {
      session: data
        ? {
            sessionId: data.id,
            videoCurrentTimeSec: Number(data.video_current_time ?? 0),
            updatedAt: data.updated_at,
            status: data.status as "active" | "completed" | "abandoned",
          }
        : null,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[listening-session/resume] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
