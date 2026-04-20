import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SaveProgressRequest, SaveProgressResponse } from "@/lib/types";

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

    if (sessionId) {
      // Update existing session
      const { data, error } = await supabase
        .from("learning_sessions")
        .update({
          current_segment_index: currentSegmentIndex,
          active_segment_index: currentSegmentIndex,
          video_current_time: videoCurrentTimeSec,
          accuracy,
          total_attempts: totalAttempts,
          attempt_count: totalAttempts,
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId)
        .eq("user_id", user.id)
        .select("id")
        .single();

      if (error) {
        console.error("[save-progress] update error:", error);
        return NextResponse.json({ error: "Failed to update session" }, { status: 500 });
      }

      if (!data) {
        return NextResponse.json({ error: "Failed to update session" }, { status: 500 });
      }

      console.log(`[save-progress] updated session ${sessionId} segment=${currentSegmentIndex}`);
      return NextResponse.json<SaveProgressResponse>({
        sessionId,
        status,
      });
    } else {
      // Reuse an existing active session for this user+video when available.
      const { data: existingActiveSession, error: existingSessionError } = await supabase
        .from("learning_sessions")
        .select("id, transcript_id")
        .eq("user_id", user.id)
        .eq("youtube_video_id", youtubeVideoId)
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingSessionError) {
        console.error("[save-progress] existing active session query error:", existingSessionError);
        return NextResponse.json({ error: "Failed to save session" }, { status: 500 });
      }

      if (existingActiveSession) {
        const { data, error } = await supabase
          .from("learning_sessions")
          .update({
            transcript_id: transcriptId ?? existingActiveSession.transcript_id ?? null,
            current_segment_index: currentSegmentIndex,
            active_segment_index: currentSegmentIndex,
            video_current_time: videoCurrentTimeSec,
            accuracy,
            total_attempts: totalAttempts,
            attempt_count: totalAttempts,
            status,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingActiveSession.id)
          .eq("user_id", user.id)
          .select("id")
          .single();

        if (error || !data) {
          console.error("[save-progress] existing session update error:", error);
          return NextResponse.json({ error: "Failed to update existing session" }, { status: 500 });
        }

        return NextResponse.json<SaveProgressResponse>({
          sessionId: existingActiveSession.id,
          status,
        });
      }

      const { data, error } = await supabase
        .from("learning_sessions")
        .insert({
          user_id: user.id,
          youtube_video_id: youtubeVideoId,
          transcript_id: transcriptId ?? null,
          current_segment_index: currentSegmentIndex,
          active_segment_index: currentSegmentIndex,
          video_current_time: videoCurrentTimeSec,
          accuracy,
          total_attempts: totalAttempts,
          attempt_count: totalAttempts,
          status,
        })
        .select("id")
        .single();

      if (error || !data) {
        console.error("[save-progress] insert error:", error);
        return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
      }

      console.log(`[save-progress] created session ${data.id} for video ${youtubeVideoId}`);
      return NextResponse.json<SaveProgressResponse>({
        sessionId: data.id,
        status,
      });
    }
  } catch (err) {
    console.error("[save-progress] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
