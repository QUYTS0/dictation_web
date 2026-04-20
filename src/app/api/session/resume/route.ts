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

    const { data, error } = await supabase
      .from("learning_sessions")
      .select(
        "id, current_segment_index, active_segment_index, video_current_time, accuracy, total_attempts, attempt_count, updated_at"
      )
      .eq("user_id", user.id)
      .eq("youtube_video_id", videoId)
      .eq("status", "active")
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
            currentSegmentIndex:
              data.active_segment_index ?? data.current_segment_index ?? 0,
            videoCurrentTimeSec: Number(data.video_current_time ?? 0),
            accuracy: Number(data.accuracy ?? 0),
            totalAttempts: data.attempt_count ?? data.total_attempts ?? 0,
            updatedAt: data.updated_at,
          }
        : null,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[session/resume] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
