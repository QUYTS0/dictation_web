import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isVideoId, mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import type { PracticeMode } from "@/lib/types/learning";

interface RouteParams {
  params: Promise<{ videoId: string }>;
}

const MODES: ReadonlyArray<PracticeMode> = ["dictation", "listening", "shadowing"];

/**
 * Records an EXPLICIT mode switch as the video's last mode (the default
 * mode when the video is reopened on any device). A convenience value only:
 * it creates no practice credit, no activity time and no round.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { videoId } = await params;
  let body: { mode?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const mode = body.mode as PracticeMode;
  if (!isVideoId(videoId) || !MODES.includes(mode)) {
    return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data, error } = await supabase.rpc("fn_set_video_last_mode", { p_youtube_video_id: videoId, p_mode: mode });
  if (error || !data) return mapLearningReadError(error, "videos/mode");
  return NextResponse.json(data as { videoId: string; lastMode: PracticeMode });
}
