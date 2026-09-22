import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { fetchYouTubeVideoTitle } from "@/lib/youtube";
import type { TranscriptResponse, TranscriptSegment } from "@/lib/types";

interface RouteParams {
  params: Promise<{ videoId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { videoId } = await params;
    const lang = request.nextUrl.searchParams.get("lang") ?? "en";
    // When present, the client is asking for one exact, pinned revision
    // (e.g. an existing session's transcript_id) — never "whatever is
    // current now" (Phase 0 — see .claude/video-learning-management-plan.md).
    const pinnedTranscriptId = request.nextUrl.searchParams.get("transcriptId");

    if (!videoId) {
      return NextResponse.json(
        { error: "videoId is required" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    let transcript: {
      id: string;
      status: "processing" | "ready" | "failed";
      source: "cache" | "ai" | "manual";
    } | null = null;

    if (pinnedTranscriptId) {
      const { data: pinned, error: pinnedError } = await supabase
        .from("transcripts")
        .select("id, status, source, youtube_video_id, language")
        .eq("id", pinnedTranscriptId)
        .maybeSingle();

      if (pinnedError) {
        console.error("[transcript GET] pinned transcript DB error:", pinnedError);
        return NextResponse.json({ error: "Database error" }, { status: 500 });
      }

      // A pinned id that doesn't exist, or belongs to a different
      // video/language, is never silently substituted with "current" —
      // that would mean rendering different content than the session it
      // was requested for actually pins.
      if (!pinned || pinned.youtube_video_id !== videoId || pinned.language !== lang) {
        return NextResponse.json(
          { error: "The requested transcript revision is not available for this video/language.", status: "error" },
          { status: 404 }
        );
      }

      transcript = pinned;
    } else {
      // No pinned id — resolve the video's current revision. is_current is
      // the single authoritative pointer (Phase 0), never "whichever ready
      // row was most recently updated," which stopped being unambiguous
      // once regeneration can leave multiple ready rows coexisting.
      const { data: currentTranscript, error: currentError } = await supabase
        .from("transcripts")
        .select("id, status, source")
        .eq("youtube_video_id", videoId)
        .eq("language", lang)
        .eq("is_current", true)
        .maybeSingle();

      if (currentError) {
        console.error("[transcript GET] current transcript DB error:", currentError);
        return NextResponse.json({ error: "Database error" }, { status: 500 });
      }

      if (currentTranscript) {
        transcript = currentTranscript;
      } else {
        // No current (ready) revision yet — fall back to the most recent
        // row of any status so a still-"processing" or "failed" attempt is
        // reported accurately instead of looking like "no transcript at all".
        const { data: latestTranscript, error: latestError } = await supabase
          .from("transcripts")
          .select("id, status, source")
          .eq("youtube_video_id", videoId)
          .eq("language", lang)
          .order("updated_at", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latestError) {
          console.error("[transcript GET] latest transcript DB error:", latestError);
          return NextResponse.json({ error: "Database error" }, { status: 500 });
        }

        transcript = latestTranscript ?? null;
      }
    }

    const { data: videoRow } = await supabase
      .from("videos")
      .select("title")
      .eq("youtube_video_id", videoId)
      .maybeSingle();

    // Older/pre-existing video rows may predate title backfilling on resolve —
    // fill it in lazily here so the UI can show a real title instead of the ID.
    let title = videoRow?.title ?? null;
    if (!title) {
      title = await fetchYouTubeVideoTitle(videoId);
      if (title) {
        await supabase.from("videos").update({ title }).eq("youtube_video_id", videoId);
      }
    }

    if (!transcript) {
      // No transcript at all — return processing to prompt generation
      console.log(`[transcript GET] no transcript found for ${videoId}, triggering generation`);
      return NextResponse.json<TranscriptResponse>({
        status: "processing",
        segments: [],
        transcriptId: null,
      });
    }

    if (transcript.status === "processing") {
      return NextResponse.json<TranscriptResponse>({
        status: "processing",
        segments: [],
        transcriptId: transcript.id,
      });
    }

    if (transcript.status === "failed") {
      return NextResponse.json<TranscriptResponse>({
        status: "failed",
        segments: [],
        transcriptId: transcript.id,
      });
    }

    // Fetch segments
    const { data: rows, error: sError } = await supabase
      .from("transcript_segments")
      .select("*")
      .eq("transcript_id", transcript.id)
      .order("segment_index", { ascending: true });

    if (sError) {
      console.error("[transcript GET] segments DB error:", sError);
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    const segments: TranscriptSegment[] = (rows ?? []).map(
      (r: {
        id: string;
        transcript_id: string;
        segment_index: number;
        start_sec: number;
        end_sec: number;
        duration_sec: number;
        text_raw: string;
        text_normalized: string;
      }) => ({
        id: r.id,
        transcript_id: r.transcript_id,
        segmentIndex: r.segment_index,
        start: r.start_sec,
        end: r.end_sec,
        duration: r.duration_sec,
        text: r.text_raw,
        textNormalized: r.text_normalized,
      })
    );

    console.log(
      `[transcript GET] videoId=${videoId} source=${transcript.source} segments=${segments.length}`
    );

    return NextResponse.json<TranscriptResponse>({
      status: "ready",
      source: transcript.source,
      title,
      segments,
      transcriptId: transcript.id,
    });
  } catch (err) {
    console.error("[transcript GET] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
