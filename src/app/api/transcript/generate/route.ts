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
//
// Pipeline:
//   1. normalizeCues   – convert offsets/durations to seconds; compute real
//                        end times using next cue's start (avoiding YouTube's
//                        inflated "display duration").
//   2. expandMultiSentenceCues – split single cues that contain multiple
//                        sentences (e.g. "Jake. Do you think…") into
//                        individual sub-cues with interpolated timestamps.
//   3. mergeExpandedCues – accumulate sub-cues into segments, splitting on
//                        hard punctuation, soft punctuation, or max duration.
//   4. mergeShortTails – re-attach tiny tail segments (< 2 s or < 3 words)
//                        back onto the preceding segment to avoid fragments
//                        like a standalone "natural."
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

// A normalised cue with timestamps already converted to seconds and real end time.
interface NormalizedCue {
  text: string;
  startSec: number;
  endSec: number;
}

const MAX_SEGMENT_DURATION_SEC = 6;
const SOFT_SPLIT_DURATION_SEC = 3;
/** Segments shorter than this (seconds) or with fewer than MIN_WORDS words are
 *  merged back into the preceding segment during the tail-merge pass. */
const MIN_SEGMENT_DURATION_SEC = 2;
const MIN_SEGMENT_WORDS = 3;

// Number of leading cues to sample when detecting offset/duration units.
const UNIT_DETECT_SAMPLE_SIZE = 10;
// Threshold separating ms from seconds: InnerTube cues are 500-10000ms; classic
// XML cues are 0.5-10s. 100 sits safely between the two ranges (10s max in
// seconds format, 500ms min in ms format) making it a reliable decision point.
const MS_DURATION_THRESHOLD = 100;

// ---------------------------------------------------------------------------
// Step 1 – normalise raw cues to seconds and compute real end times.
// ---------------------------------------------------------------------------
function normalizeCues(cues: CueItem[]): NormalizedCue[] {
  // youtube-transcript returns offsets/durations in ms for InnerTube (srv3)
  // but in seconds for the classic XML fallback.
  const sampleCues = cues.slice(0, UNIT_DETECT_SAMPLE_SIZE);
  const validDurations = sampleCues.map((c) => c.duration).filter((d) => d > 0);
  const validOffsets = sampleCues.map((c) => c.offset).filter((o) => o > 0);
  const sampleValues = [...validDurations, ...validOffsets];
  const avgSample = sampleValues.length
    ? sampleValues.reduce((a, b) => a + b, 0) / sampleValues.length
    : 0;
  if (sampleValues.length === 0) {
    console.warn("[mergeIntoSentences] no non-zero offset/duration samples; defaulting to ms");
  }
  const divisor = sampleValues.length === 0 || avgSample >= MS_DURATION_THRESHOLD ? 1000 : 1;

  // Pre-compute the next non-empty cue's start (in seconds) for every cue in
  // O(n).  YouTube's json3 timedtext "duration" is a display duration that
  // extends past the next cue's start (fade-out overlap).  Using
  // next-cue-start avoids the inflated end_sec values.
  const nextNonEmptyStartSec: (number | null)[] = new Array(cues.length).fill(null);
  let lastNonEmptyStartSec: number | null = null;
  for (let i = cues.length - 1; i >= 0; i--) {
    if (cues[i].text.replace(/\n/g, " ").trim()) {
      nextNonEmptyStartSec[i] = lastNonEmptyStartSec;
      lastNonEmptyStartSec = cues[i].offset / divisor;
    }
  }

  const result: NormalizedCue[] = [];
  for (let i = 0; i < cues.length; i++) {
    const text = cues[i].text.replace(/\n/g, " ").trim();
    if (!text) continue;
    const startSec = cues[i].offset / divisor;
    const next = nextNonEmptyStartSec[i];
    const endSec = next !== null ? next : startSec + cues[i].duration / divisor;
    result.push({ text, startSec, endSec });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 2 – split single cues that contain multiple sentences.
// Matches a sentence-ending punctuation mark followed by whitespace and an
// uppercase letter (genuine sentence boundary) and splits there, distributing
// time proportionally by character count.
// ---------------------------------------------------------------------------
const INTRA_CUE_SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z])/;

function expandMultiSentenceCues(cues: NormalizedCue[]): NormalizedCue[] {
  const result: NormalizedCue[] = [];
  for (const cue of cues) {
    const parts = cue.text.split(INTRA_CUE_SENTENCE_SPLIT);
    if (parts.length <= 1) {
      result.push(cue);
      continue;
    }
    // Distribute the cue's time proportionally by character count.
    const totalDuration = cue.endSec - cue.startSec;
    const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
    let charPos = 0;
    for (const part of parts) {
      const startFrac = charPos / totalChars;
      charPos += part.length;
      const endFrac = charPos / totalChars;
      result.push({
        text: part.trim(),
        startSec: cue.startSec + startFrac * totalDuration,
        endSec: cue.startSec + endFrac * totalDuration,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 3 – accumulate sub-cues into segments.
// ---------------------------------------------------------------------------
function mergeExpandedCues(cues: NormalizedCue[]): Segment[] {
  const result: Segment[] = [];
  let buf: string[] = [];
  let start = 0;
  let end = 0;

  for (const cue of cues) {
    if (buf.length === 0) start = cue.startSec;
    buf.push(cue.text);
    end = cue.endSec;

    const sentence = buf.join(" ").trim();
    const duration = end - start;
    const endsWithHardPunctuation = /[.!?]$/.test(sentence);
    const endsWithSoftPunctuation = /[,;]$/.test(sentence);

    if (
      endsWithHardPunctuation ||
      duration >= MAX_SEGMENT_DURATION_SEC ||
      (endsWithSoftPunctuation && duration >= SOFT_SPLIT_DURATION_SEC)
    ) {
      result.push({ text: sentence, start, duration });
      buf = [];
    }
  }

  if (buf.length > 0) {
    result.push({ text: buf.join(" ").trim(), start, duration: end - start });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 4 – merge very short tail segments back onto the preceding segment.
// A "tail" is any segment that is shorter than MIN_SEGMENT_DURATION_SEC or
// has fewer words than MIN_SEGMENT_WORDS.  This prevents standalone fragments
// like "natural." (0.8 s) that arise when a max-duration cutoff fires just
// before the sentence-ending word.
// ---------------------------------------------------------------------------
function mergeShortTails(segments: Segment[]): Segment[] {
  if (segments.length <= 1) return segments;
  const result: Segment[] = [];
  for (const seg of segments) {
    const wordCount = seg.text.trim().split(/\s+/).filter(Boolean).length;
    const isTiny = seg.duration < MIN_SEGMENT_DURATION_SEC && wordCount < MIN_SEGMENT_WORDS;
    if (isTiny && result.length > 0) {
      const prev = result[result.length - 1];
      const newEnd = seg.start + seg.duration;
      result[result.length - 1] = {
        text: prev.text + " " + seg.text,
        start: prev.start,
        duration: newEnd - prev.start,
      };
    } else {
      result.push({ ...seg });
    }
  }
  return result;
}

function mergeIntoSentences(cues: CueItem[]): Segment[] {
  const normalized = normalizeCues(cues);
  const expanded = expandMultiSentenceCues(normalized);
  const merged = mergeExpandedCues(expanded);
  return mergeShortTails(merged);
}
