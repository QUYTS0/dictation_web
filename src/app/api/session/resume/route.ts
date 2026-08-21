import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ResumeSessionResponse } from "@/lib/types";

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

    // Fetch the latest session regardless of status (not just "active") so a
    // finished video reports its completed session back to the caller instead
    // of looking like a brand-new video — see resumeState.status handling in
    // useDictationSession, which is what stops a stale "in progress" row
    // from being spawned every time a completed video is reopened.
    const { data, error } = await supabase
      .from("learning_sessions")
      .select(
        "id, current_segment_index, video_current_time, accuracy, total_attempts, updated_at, status"
      )
      .eq("user_id", user.id)
      .eq("youtube_video_id", videoId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("[session/resume] query error:", error);
      return NextResponse.json({ error: "Failed to fetch session" }, { status: 500 });
    }

    const response: ResumeSessionResponse = {
      session: data
        ? {
            sessionId: data.id,
            currentSegmentIndex: data.current_segment_index ?? 0,
            videoCurrentTimeSec: Number(data.video_current_time ?? 0),
            accuracy: Number(data.accuracy ?? 0),
            totalAttempts: data.total_attempts ?? 0,
            updatedAt: data.updated_at,
            status: data.status as "active" | "completed" | "abandoned",
          }
        : null,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[session/resume] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
