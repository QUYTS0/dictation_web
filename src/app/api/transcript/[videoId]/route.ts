import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import type { TranscriptResponse, TranscriptSegment } from "@/lib/types";

interface RouteParams {
  params: Promise<{ videoId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { videoId } = await params;
    const lang = request.nextUrl.searchParams.get("lang") ?? "en";

    if (!videoId) {
      return NextResponse.json(
        { error: "videoId is required" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    // Prefer a ready transcript first to avoid selecting stale/failed duplicates.
    const { data: readyTranscript, error: readyError } = await supabase
      .from("transcripts")
      .select("id, status, source")
      .eq("youtube_video_id", videoId)
      .eq("language", lang)
      .eq("status", "ready")
      .order("updated_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (readyError) {
      console.error("[transcript GET] ready transcript DB error:", readyError);
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    const { data: latestTranscript, error: latestError } = readyTranscript
      ? { data: null, error: null }
      : await supabase
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

    const transcript = readyTranscript ?? latestTranscript;

    const { data: videoRow } = await supabase
      .from("videos")
      .select("title")
      .eq("youtube_video_id", videoId)
      .maybeSingle();

    if (!transcript) {
      // No transcript at all — return processing to prompt generation
      console.log(`[transcript GET] no transcript found for ${videoId}, triggering generation`);
      return NextResponse.json<TranscriptResponse>({
        status: "processing",
        segments: [],
      });
    }

    if (transcript.status === "processing") {
      return NextResponse.json<TranscriptResponse>({
        status: "processing",
        segments: [],
      });
    }

    if (transcript.status === "failed") {
      return NextResponse.json<TranscriptResponse>({
        status: "failed",
        segments: [],
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
      title: videoRow?.title ?? null,
      segments,
    });
  } catch (err) {
    console.error("[transcript GET] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
