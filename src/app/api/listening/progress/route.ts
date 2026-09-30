import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/practice/validation";
import type { ListeningProgressResponse } from "@/lib/practice/listeningTypes";

/**
 * The caller's Listening coverage for one video revision (plan §6.3/§11.1),
 * read with the caller's own identity (owner-only RLS on listening_progress).
 * `transcriptId` omitted/empty → the pre-transcript (raw, no percentage) row.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const videoId = request.nextUrl.searchParams.get("videoId");
  const transcriptParam = request.nextUrl.searchParams.get("transcriptId");
  const transcriptId = transcriptParam ? transcriptParam : null;
  if (!videoId || videoId.length > 64) return NextResponse.json({ error: "videoId is required.", code: "invalid_payload" }, { status: 400 });
  if (transcriptId !== null && !isUuid(transcriptId)) {
    return NextResponse.json({ error: "Invalid transcriptId.", code: "invalid_payload" }, { status: 400 });
  }

  let query = supabase
    .from("listening_progress")
    .select("covered_sec, transcript_covered_sec, coverage_ratio, listened_through, listened_through_at, last_position_sec")
    .eq("user_id", user.id)
    .eq("youtube_video_id", videoId);
  query = transcriptId ? query.eq("transcript_id", transcriptId) : query.is("transcript_id", null).is("superseded_at", null);
  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error("[listening/progress] read failed:", error);
    return NextResponse.json({ error: "Couldn't load listening progress." }, { status: 500 });
  }
  const row = data as {
    covered_sec: number | string;
    transcript_covered_sec: number | string | null;
    coverage_ratio: number | string;
    listened_through: boolean;
    listened_through_at: string | null;
    last_position_sec: number | string;
  } | null;
  const body: ListeningProgressResponse = {
    videoId,
    transcriptId,
    coveredSec: row ? Number(row.covered_sec) : 0,
    transcriptCoveredSec: row?.transcript_covered_sec != null ? Number(row.transcript_covered_sec) : null,
    coverageRatio: row ? Number(row.coverage_ratio) : 0,
    listenedThrough: row?.listened_through ?? false,
    listenedThroughAt: row?.listened_through_at ?? null,
    lastPositionSec: row ? Number(row.last_position_sec) : 0,
    hasHistory: !!row,
  };
  return NextResponse.json(body);
}
