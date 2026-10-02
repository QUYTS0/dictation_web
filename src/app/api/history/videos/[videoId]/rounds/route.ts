import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isVideoId, mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import type { HistoryVideoRounds } from "@/lib/types/learning";

interface RouteParams {
  params: Promise<{ videoId: string }>;
}

/**
 * A video's rounds for an expanded History card (fn_history_video_rounds,
 * 042): newest first, each with its own coverage and session count, plus
 * the default round (active, else latest) and the number of round-less
 * Listening sittings. The caller's own rounds only; a read.
 */
export async function GET(_request: Request, { params }: RouteParams) {
  const { videoId } = await params;
  if (!isVideoId(videoId)) return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data, error } = await supabase.rpc("fn_history_video_rounds", { p_video: videoId, p_limit: 50 });
  if (error || !data) return mapLearningReadError(error, "history/videos/rounds", "042");
  return NextResponse.json(data as HistoryVideoRounds);
}
