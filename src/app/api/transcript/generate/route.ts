import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeText } from "@/lib/utils/text";

interface GenerateRequest {
  videoId: string;
  language?: string;
  /** Optional pre-built segments (e.g., from YouTube captions) */
  segments?: Array<{
    segmentIndex: number;
    start: number;
    end: number;
    text: string;
  }>;
}

export async function POST(request: NextRequest) {
  try {
    const body: GenerateRequest = await request.json();
    const { videoId, language = "en", segments } = body;

    if (!videoId || typeof videoId !== "string") {
      return NextResponse.json({ error: "videoId is required" }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Ensure the video record exists
    await supabase
      .from("videos")
      .upsert({ youtube_video_id: videoId }, { onConflict: "youtube_video_id" });

    // Create a transcript record in "processing" state
    const { data: transcript, error: tError } = await supabase
      .from("transcripts")
      .insert({
        youtube_video_id: videoId,
        language,
        source: segments ? "manual" : "ai",
        status: "processing",
        version: 1,
      })
      .select("id")
      .single();

    if (tError || !transcript) {
      console.error("[transcript generate] insert error:", tError);
      return NextResponse.json({ error: "Failed to create transcript record" }, { status: 500 });
    }

    const transcriptId = transcript.id;
    console.log(`[transcript generate] created transcript ${transcriptId} for video ${videoId}`);

    // If segments were provided directly (e.g., from caption API), store them immediately
    if (segments && segments.length > 0) {
      const rows = segments.map((seg) => ({
        transcript_id: transcriptId,
        segment_index: seg.segmentIndex,
        start_sec: seg.start,
        end_sec: seg.end,
        duration_sec: seg.end - seg.start,
        text_raw: seg.text,
        text_normalized: normalizeText(seg.text, "relaxed"),
      }));

      const { error: insertError } = await supabase
        .from("transcript_segments")
        .insert(rows);

      if (insertError) {
        console.error("[transcript generate] segment insert error:", insertError);
        await supabase
          .from("transcripts")
          .update({ status: "failed" })
          .eq("id", transcriptId);
        return NextResponse.json({ error: "Failed to store segments" }, { status: 500 });
      }

      const fullText = segments.map((s) => s.text).join(" ");
      await supabase
        .from("transcripts")
        .update({ status: "ready", full_text: fullText })
        .eq("id", transcriptId);

      console.log(`[transcript generate] stored ${segments.length} segments for transcript ${transcriptId}`);
      return NextResponse.json({
        transcriptId,
        status: "ready",
        segmentCount: segments.length,
      });
    }

    // Without segments, return processing state so the client can poll
    return NextResponse.json({
      transcriptId,
      status: "processing",
    });
  } catch (err) {
    console.error("[transcript generate] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
