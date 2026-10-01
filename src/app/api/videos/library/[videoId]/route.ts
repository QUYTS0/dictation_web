import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isVideoId, mapLearningReadError } from "@/lib/supabase/learningReadErrors";

interface RouteParams {
  params: Promise<{ videoId: string }>;
}

/**
 * Removes the video from the CALLER's Library only (fn_library_remove_video).
 * Rounds, answers, recordings, reports, Listening progress, transcripts and
 * every other user's data are kept; adding the video again brings the card
 * back with its history. Idempotent: `removed: false` when it wasn't there.
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { videoId } = await params;
  if (!isVideoId(videoId)) return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data, error } = await supabase.rpc("fn_library_remove_video", { p_youtube_video_id: videoId });
  if (error || !data) return mapLearningReadError(error, "videos/library/remove");
  return NextResponse.json(data as { videoId: string; removed: boolean });
}
