import { NextRequest, NextResponse } from "next/server";
import { YoutubeTranscript } from "youtube-transcript";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizeText } from "@/lib/utils/text";

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

    // If force=true, mark all existing transcripts as failed so we always do a fresh fetch
    if (force) {
      await supabase
        .from("transcripts")
        .update({ status: "failed" })
        .eq("youtube_video_id", videoId)
        .eq("language", language)
        .in("status", ["ready", "processing"]);
    }

    // Check if there is already a READY transcript for this video (cached result)
    const { data: existing } = await supabase
      .from("transcripts")
      .select("id, status")
      .eq("youtube_video_id", videoId)
      .eq("language", language)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      console.log(`[transcript generate] ready transcript ${existing.id} already exists, skipping re-fetch`);
      return NextResponse.json({ transcriptId: existing.id, status: existing.status });
    }

    // Mark any previous stale "processing" transcripts for this video as failed
    // so they don't block future attempts
    await supabase
      .from("transcripts")
      .update({ status: "failed" })
      .eq("youtube_video_id", videoId)
      .eq("language", language)
      .eq("status", "processing");

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

const MAX_SEGMENT_DURATION_SEC = 6;
const SOFT_SPLIT_DURATION_SEC = 3;

// Number of leading cues to sample when detecting offset/duration units.
const UNIT_DETECT_SAMPLE_SIZE = 10;
// Threshold separating ms from seconds: InnerTube cues are 500-10000ms; classic
// XML cues are 0.5-10s. 100 sits safely between the two ranges (10s max in
// seconds format, 500ms min in ms format) making it a reliable decision point.
const MS_DURATION_THRESHOLD = 100;

function mergeIntoSentences(cues: CueItem[]): Segment[] {
  const result: Segment[] = [];
  let buf: string[] = [];
  let start = 0;
  let end = 0;

  // youtube-transcript returns offsets/durations in ms for InnerTube (srv3) format
  // but in seconds for the classic XML fallback. Detect by sampling durations and
  // offsets: real caption cues are 0.5-10s (500-10000ms). Values ≥ 100 → ms.
  const sampleCues = cues.slice(0, UNIT_DETECT_SAMPLE_SIZE);
  const validDurations = sampleCues.map((c) => c.duration).filter((d) => d > 0);
  const validOffsets = sampleCues.map((c) => c.offset).filter((o) => o > 0);
  const sampleValues = [...validDurations, ...validOffsets];
  const avgSample = sampleValues.length
    ? sampleValues.reduce((a, b) => a + b, 0) / sampleValues.length
    : 0;
  // If no non-zero samples are available (e.g., first cues all start at 0),
  // fall back to assuming ms (InnerTube is the common path for modern videos).
  if (sampleValues.length === 0) {
    console.warn("[mergeIntoSentences] no non-zero offset/duration samples; defaulting to ms");
  }
  const divisor = sampleValues.length === 0 || avgSample >= MS_DURATION_THRESHOLD ? 1000 : 1;

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const text = cue.text.replace(/\n/g, " ").trim();
    if (!text) continue;

    const cueStart = cue.offset / divisor;
    // YouTube's json3 timedtext format gives each cue a "display duration" that
    // extends past the point where the next cue starts (overlap / fade-out time).
    // Using offset + duration therefore inflates end_sec.  Instead, use the next
    // non-empty cue's offset as the real end of this cue.  For the final cue fall
    // back to offset + duration.
    let nextOffset: number | null = null;
    for (let ni = i + 1; ni < cues.length; ni++) {
      if (cues[ni].text.replace(/\n/g, " ").trim()) {
        nextOffset = cues[ni].offset / divisor;
        break;
      }
    }
    const cueEnd = nextOffset !== null ? nextOffset : cueStart + cue.duration / divisor;

    if (buf.length === 0) {
      start = cueStart;
    }
    buf.push(text);
    end = cueEnd;

    const sentence = buf.join(" ");
    const duration = end - start;
    const endsWithHardPunctuation = /[.!?]$/.test(sentence.trim());
    const endsWithSoftPunctuation = /[,;]$/.test(sentence.trim());

    if (endsWithHardPunctuation || duration >= MAX_SEGMENT_DURATION_SEC ||
        (endsWithSoftPunctuation && duration >= SOFT_SPLIT_DURATION_SEC)) {
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
