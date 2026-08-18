import { NextRequest, NextResponse } from "next/server";
import { YoutubeTranscript } from "youtube-transcript";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeText } from "@/lib/utils/text";
import { checkRateLimit } from "@/lib/rateLimit";
import { mergeIntoSentences } from "@/lib/utils/segment";

interface GenerateRequest {
  videoId: string;
  language?: string;
  /**
   * When true, mark any existing transcript (including "ready" ones) as failed
   * so a fresh fetch is performed. Use this when the cached transcript has
   * incorrect timestamps or mismatched text/audio.
   */
  force?: boolean;
  /** Optional pre-built segments (e.g., from YouTube captions) */
  segments?: Array<{
    segmentIndex: number;
    start: number;
    end: number;
    text: string;
  }>;
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "transcript/generate", {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body: GenerateRequest = await request.json();
    const { videoId, language = "en", segments, force = false } = body;

    if (!videoId || typeof videoId !== "string") {
      return NextResponse.json({ error: "videoId is required" }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Ensure the video record exists
    await supabase
      .from("videos")
      .upsert({ youtube_video_id: videoId }, { onConflict: "youtube_video_id" });

    const { data: existingTranscripts, error: existingTranscriptsError } = await supabase
      .from("transcripts")
      .select("id, status, updated_at, created_at")
      .eq("youtube_video_id", videoId)
      .eq("language", language)
      .order("updated_at", { ascending: false })
      .order("created_at", { ascending: false });

    if (existingTranscriptsError) {
      console.error("[transcript generate] existing transcript query error:", existingTranscriptsError);
      return NextResponse.json({ error: "Failed to inspect transcript state" }, { status: 500 });
    }

    const canonicalTranscript = existingTranscripts?.[0] ?? null;
    const duplicateTranscriptIds = (existingTranscripts ?? []).slice(1).map((item) => item.id);

    if (duplicateTranscriptIds.length > 0) {
      const { error: duplicateDeleteError } = await supabase
        .from("transcripts")
        .delete()
        .in("id", duplicateTranscriptIds);
      if (duplicateDeleteError) {
        console.error("[transcript generate] duplicate cleanup error:", duplicateDeleteError);
        return NextResponse.json({ error: "Failed to cleanup duplicate transcripts" }, { status: 500 });
      }
    }

    if (!force && canonicalTranscript?.status === "ready") {
      const { count: segmentCount, error: segmentCountError } = await supabase
        .from("transcript_segments")
        .select("id", { count: "exact", head: true })
        .eq("transcript_id", canonicalTranscript.id);
      if (segmentCountError) {
        console.error("[transcript generate] ready transcript segment count error:", segmentCountError);
        return NextResponse.json({ error: "Failed to validate ready transcript" }, { status: 500 });
      }
      if ((segmentCount ?? 0) > 0) {
        console.log(
          `[transcript generate] reusing ready transcript ${canonicalTranscript.id} (segments=${segmentCount})`
        );
        return NextResponse.json({ transcriptId: canonicalTranscript.id, status: canonicalTranscript.status });
      }
    }

    let transcriptId: string | null = null;
    if (canonicalTranscript) {
      const { error: canonicalUpdateError } = await supabase
        .from("transcripts")
        .update({
          status: "processing",
          source: segments ? "manual" : "cache",
          full_text: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", canonicalTranscript.id);
      if (canonicalUpdateError) {
        console.error("[transcript generate] canonical transcript update error:", canonicalUpdateError);
        return NextResponse.json({ error: "Failed to refresh transcript record" }, { status: 500 });
      }

      const { error: previousSegmentDeleteError } = await supabase
        .from("transcript_segments")
        .delete()
        .eq("transcript_id", canonicalTranscript.id);
      if (previousSegmentDeleteError) {
        console.error("[transcript generate] previous segment cleanup error:", previousSegmentDeleteError);
        return NextResponse.json({ error: "Failed to reset transcript segments" }, { status: 500 });
      }
      transcriptId = canonicalTranscript.id;
    } else {
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
      transcriptId = transcript.id;
    }

    if (!transcriptId) {
      return NextResponse.json({ error: "Failed to initialize transcript" }, { status: 500 });
    }
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

    if (merged.length === 0) {
      console.error(
        `[transcript generate] mergeIntoSentences produced 0 segments from ${ytItems.length} cues` +
        ` (cue texts may be empty or unit detection may have failed)`
      );
      await supabase
        .from("transcripts")
        .update({ status: "failed" })
        .eq("id", transcriptId);
      return NextResponse.json(
        { transcriptId, status: "failed", error: "Could not extract segments from captions." },
        { status: 422 }
      );
    }

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
    const { error: updateError } = await supabase
      .from("transcripts")
      .update({ status: "ready", full_text: fullText })
      .eq("id", transcriptId);

    if (updateError) {
      console.error("[transcript generate] status update error:", updateError);
      // Attempt to mark as failed so the client doesn't poll forever
      await supabase.from("transcripts").update({ status: "failed" }).eq("id", transcriptId);
      return NextResponse.json({ error: "Failed to finalize transcript" }, { status: 500 });
    }

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

