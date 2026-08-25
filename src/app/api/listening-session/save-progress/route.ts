import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SaveListeningProgressRequest, SaveListeningProgressResponse } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const body: SaveListeningProgressRequest = await request.json();
    const { sessionId, youtubeVideoId, transcriptId, videoCurrentTimeSec, status = "active" } = body;

    if (!youtubeVideoId) {
      return NextResponse.json({ error: "youtubeVideoId is required" }, { status: 400 });
    }

    if (sessionId) {
      const { data, error } = await supabase
        .from("listening_sessions")
        .update({
          video_current_time: videoCurrentTimeSec,
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId)
        .eq("user_id", user.id)
        .select("id")
        .single();

      if (error || !data) {
        console.error("[listening-session/save-progress] update error:", error);
        return NextResponse.json({ error: "Failed to update session" }, { status: 500 });
      }

      return NextResponse.json<SaveListeningProgressResponse>({ sessionId, status });
    }

    // Reuse an existing active session for this user+video when available.
    const { data: existingActiveSession, error: existingSessionError } = await supabase
      .from("listening_sessions")
      .select("id, transcript_id")
      .eq("user_id", user.id)
      .eq("youtube_video_id", youtubeVideoId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingSessionError) {
      console.error("[listening-session/save-progress] existing session query error:", existingSessionError);
      return NextResponse.json({ error: "Failed to save session" }, { status: 500 });
    }

    if (existingActiveSession) {
      const { data, error } = await supabase
        .from("listening_sessions")
        .update({
          transcript_id: transcriptId ?? existingActiveSession.transcript_id ?? null,
          video_current_time: videoCurrentTimeSec,
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingActiveSession.id)
        .eq("user_id", user.id)
        .select("id")
        .single();

      if (error || !data) {
        console.error("[listening-session/save-progress] existing session update error:", error);
        return NextResponse.json({ error: "Failed to update existing session" }, { status: 500 });
      }

      return NextResponse.json<SaveListeningProgressResponse>({ sessionId: existingActiveSession.id, status });
    }

    const { data, error } = await supabase
      .from("listening_sessions")
      .insert({
        user_id: user.id,
        youtube_video_id: youtubeVideoId,
        transcript_id: transcriptId ?? null,
        video_current_time: videoCurrentTimeSec,
        status,
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("[listening-session/save-progress] insert error:", error);
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
    }

    return NextResponse.json<SaveListeningProgressResponse>({ sessionId: data.id, status });
  } catch (err) {
    console.error("[listening-session/save-progress] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
