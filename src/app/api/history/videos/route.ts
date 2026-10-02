import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isVideoId, mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import type { HistoryVideosPage } from "@/lib/types/learning";

/**
 * Practice History, one entry per VIDEO with learning history
 * (fn_history_videos, migration 042), newest learning activity first.
 * Grouped and paginated on the server: keyset by (lastActivityAt desc,
 * videoId asc) — pass the last item's `lastActivityAt` and `videoId` back
 * as `beforeLastActivityAt` / `beforeVideoId`. A read: it never creates a
 * round or re-adds a removed video to the Library.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const limit = Number(params.get("limit") ?? 10);
  const beforeAt = params.get("beforeLastActivityAt");
  const beforeVideo = params.get("beforeVideoId");
  const cursorOk =
    (beforeAt === null && beforeVideo === null) || (beforeAt !== null && !Number.isNaN(Date.parse(beforeAt)) && isVideoId(beforeVideo));
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !cursorOk) {
    return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("fn_history_videos", {
    p_limit: limit,
    p_before_last_activity_at: beforeAt,
    p_before_video: beforeVideo,
  });
  if (error || !data) return mapLearningReadError(error, "history/videos", "042");
  return NextResponse.json(data as HistoryVideosPage);
}
