import { NextRequest, NextResponse } from "next/server";
import { YoutubeTranscript } from "youtube-transcript";
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

    // Check if a transcript is already being processed or is ready for this video
    const { data: existing } = await supabase
      .from("transcripts")
      .select("id, status")
      .eq("youtube_video_id", videoId)
      .eq("language", language)
      .in("status", ["processing", "ready"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      console.log(`[transcript generate] transcript ${existing.id} already exists with status=${existing.status}`);
      return NextResponse.json({ transcriptId: existing.id, status: existing.status });
    }

    // Create a transcript record in "processing" state
    const { data: transcript, error: tError } = await supabase
      .from("transcripts")
      .insert({
        youtube_video_id: videoId,
        language,
        source: segments ? "manual" : "cache",
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

    // No segments provided — fetch from YouTube captions
    let ytItems;
    try {
      ytItems = await YoutubeTranscript.fetchTranscript(videoId, { lang: language });
    } catch (captionErr) {
      console.error("[transcript generate] YouTube caption fetch error:", captionErr);
      const errMsg = captionErr instanceof Error ? captionErr.message : String(captionErr);
      const isLangUnavailable = errMsg.toLowerCase().includes("no transcripts") ||
        errMsg.toLowerCase().includes("language");
      const userMessage = isLangUnavailable
        ? `No ${language} captions available. Try a video with English captions enabled.`
        : "Captions are disabled for this video. Please choose a video with captions enabled.";
      await supabase
        .from("transcripts")
        .update({ status: "failed" })
        .eq("id", transcriptId);
      return NextResponse.json(
        { transcriptId, status: "failed", error: userMessage },
        { status: 422 }
      );
    }

    if (!ytItems || ytItems.length === 0) {
      await supabase
        .from("transcripts")
        .update({ status: "failed" })
        .eq("id", transcriptId);
      return NextResponse.json(
        { transcriptId, status: "failed", error: "No captions found for this video." },
        { status: 422 }
      );
    }

    // Merge very short cue lines into sentence-level segments
    const merged = mergeIntoSentences(ytItems);

    const rows = merged.map((seg, i) => ({
      transcript_id: transcriptId,
      segment_index: i,
      start_sec: seg.start,
      end_sec: seg.start + seg.duration,
      duration_sec: seg.duration,
      text_raw: seg.text,
      text_normalized: normalizeText(seg.text, "relaxed"),
    }));

    const { error: segInsertError } = await supabase
      .from("transcript_segments")
      .insert(rows);

    if (segInsertError) {
      console.error("[transcript generate] segment insert error:", segInsertError);
      await supabase
        .from("transcripts")
        .update({ status: "failed" })
        .eq("id", transcriptId);
      return NextResponse.json({ error: "Failed to store segments" }, { status: 500 });
    }

    const fullText = merged.map((s) => s.text).join(" ");
    await supabase
      .from("transcripts")
      .update({ status: "ready", full_text: fullText })
      .eq("id", transcriptId);

    console.log(
      `[transcript generate] stored ${rows.length} segments (from ${ytItems.length} cues) for transcript ${transcriptId}`
    );
    return NextResponse.json({
      transcriptId,
      status: "ready",
      segmentCount: rows.length,
    });
  } catch (err) {
    console.error("[transcript generate] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Merge very short YouTube caption cues into sentence-level segments.
// YouTube auto-captions often emit 1-3 word cues; we group them into
// natural sentences (ended by . ! ?) up to a max duration.
// ---------------------------------------------------------------------------

interface CueItem {
  text: string;
  duration: number;
  offset: number;
}

interface Segment {
  text: string;
  start: number;
  duration: number;
}

const MAX_SEGMENT_DURATION_SEC = 8;

function mergeIntoSentences(cues: CueItem[]): Segment[] {
  const result: Segment[] = [];
  let buf: string[] = [];
  let start = 0;
  let end = 0;

  for (const cue of cues) {
    const text = cue.text.replace(/\n/g, " ").trim();
    if (!text) continue;

    const cueStart = cue.offset / 1000;
    const cueEnd = cueStart + cue.duration / 1000;

    if (buf.length === 0) {
      start = cueStart;
    }
    buf.push(text);
    end = cueEnd;

    const sentence = buf.join(" ");
    const duration = end - start;
    const endsWithPunctuation = /[.!?]$/.test(sentence.trim());

    if (endsWithPunctuation || duration >= MAX_SEGMENT_DURATION_SEC) {
      result.push({ text: sentence.trim(), start, duration });
      buf = [];
    }
  }

  // Flush any remaining text
  if (buf.length > 0) {
    result.push({ text: buf.join(" ").trim(), start, duration: end - start });
  }

  return result;
}
