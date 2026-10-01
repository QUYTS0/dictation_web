import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isVideoId } from "@/lib/supabase/learningReadErrors";
import type { TranscriptVersionPreview } from "@/lib/types/learning";

interface RouteParams {
  params: Promise<{ videoId: string; transcriptId: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read-only preview of one script revision (Phase 9, plan §10.7). A pure
 * read of the shared, publicly readable transcript tables through the
 * caller's own client: it never changes which revision is current, never
 * re-pins a round and writes nothing. The revision must belong to the
 * video in the URL; a revision still being generated is not previewed.
 */
export async function GET(_request: Request, { params }: RouteParams) {
  const { videoId, transcriptId } = await params;
  if (!isVideoId(videoId) || !UUID_RE.test(transcriptId)) {
    return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data: transcript, error } = await supabase
    .from("transcripts")
    .select("id, youtube_video_id, version, status, is_current")
    .eq("id", transcriptId)
    .eq("youtube_video_id", videoId)
    .maybeSingle();
  if (error) {
    console.error("[transcripts/preview] transcript query error:", error);
    return NextResponse.json({ error: "Couldn't load this script version." }, { status: 500 });
  }
  if (!transcript) return NextResponse.json({ error: "Script version not found.", code: "transcript_not_found" }, { status: 404 });
  if (transcript.status === "processing") {
    return NextResponse.json({ error: "This script version is still being generated.", code: "transcript_not_ready" }, { status: 404 });
  }

  const { data: segments, error: segmentsError } = await supabase
    .from("transcript_segments")
    .select("segment_index, start_sec, end_sec, text_raw")
    .eq("transcript_id", transcriptId)
    .order("segment_index", { ascending: true });
  if (segmentsError) {
    console.error("[transcripts/preview] segments query error:", segmentsError);
    return NextResponse.json({ error: "Couldn't load this script version." }, { status: 500 });
  }

  const body: TranscriptVersionPreview = {
    transcriptId: transcript.id,
    videoId: transcript.youtube_video_id,
    version: transcript.version,
    status: transcript.status,
    isCurrent: transcript.is_current,
    segments: (segments ?? []).map((s) => ({
      segmentIndex: s.segment_index,
      start: Number(s.start_sec),
      end: Number(s.end_sec),
      text: s.text_raw,
    })),
  };
  return NextResponse.json(body);
}
