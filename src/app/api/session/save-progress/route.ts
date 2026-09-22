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
          video_current_time: videoCurrentTimeSec,
          accuracy,
          total_attempts: totalAttempts,
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
        .select("id")
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
        // Phase 0: a round pins its transcript revision at creation and
        // never repins it from an ordinary progress save — transcript_id is
        // deliberately left out of this UPDATE entirely (not "preserved via
        // a fallback"), so a client-supplied transcriptId here can never
        // overwrite what this session already pinned, whatever value it
        // sends.
        const { data, error } = await supabase
          .from("learning_sessions")
          .update({
            current_segment_index: currentSegmentIndex,
            video_current_time: videoCurrentTimeSec,
            accuracy,
            total_attempts: totalAttempts,
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

      // First touch for this (user, video): resolve the round's pinned
      // transcript revision SERVER-SIDE from the video's current, ready
      // transcript — never trust a client-supplied transcriptId for this
      // decision (Phase 0). Language is hardcoded "en" to match every other
      // transcript resolution in this app (fetchTranscript, transcript
      // generate/GET routes).
      const { data: currentTranscript, error: currentTranscriptError } = await supabase
        .from("transcripts")
        .select("id")
        .eq("youtube_video_id", youtubeVideoId)
        .eq("language", "en")
        .eq("is_current", true)
        .maybeSingle();

      if (currentTranscriptError) {
        console.error("[save-progress] current transcript query error:", currentTranscriptError);
        return NextResponse.json({ error: "Failed to resolve transcript revision" }, { status: 500 });
      }

      if (!currentTranscript) {
        // No ready transcript exists yet for this video — nothing to pin a
        // new round to. The practice UI only reaches this call once its own
        // transcript query is "ready", so this is a genuine race/edge case,
        // not the common path; surfaced explicitly rather than silently
        // creating a round with no pinned revision.
        return NextResponse.json(
          { error: "No ready transcript exists for this video yet.", code: "transcript_not_ready" },
          { status: 409 }
        );
      }

      // Race guard: the client's own transcriptId reflects whatever
      // revision it actually fetched/displayed and is submitting work
      // against. If the video's current revision has since moved on (a
      // regeneration published a new one between the client's fetch and
      // this first save), pinning the new round to the server's
      // now-different "current" would silently attach the client's
      // in-progress answers to a revision they were never shown — rejected
      // instead, so the client can refetch and restart cleanly.
      if (transcriptId && transcriptId !== currentTranscript.id) {
        return NextResponse.json(
          {
            error: "The transcript revision has changed since this page loaded. Please refresh and try again.",
            code: "stale_transcript_revision",
          },
          { status: 409 }
        );
      }

      const { data, error } = await supabase
        .from("learning_sessions")
        .insert({
          user_id: user.id,
          youtube_video_id: youtubeVideoId,
          transcript_id: currentTranscript.id,
          current_segment_index: currentSegmentIndex,
          video_current_time: videoCurrentTimeSec,
          accuracy,
          total_attempts: totalAttempts,
          status,
        })
        .select("id")
        .single();

      if (error || !data) {
        console.error("[save-progress] insert error:", error);
        return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
      }

      console.log(`[save-progress] created session ${data.id} for video ${youtubeVideoId} (transcript=${currentTranscript.id})`);
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
