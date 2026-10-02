import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/practice/validation";
import { isVideoId, mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import type { HistoryVideoSessionsPage } from "@/lib/types/learning";

interface RouteParams {
  params: Promise<{ videoId: string }>;
}

/**
 * The study sessions of ONE round of a video (`?roundId=`), or the video's
 * round-less Listening sittings (`?roundId=none`) — never mixed
 * (fn_history_video_sessions, 042). Keyset-paged by (startedAt desc, id
 * desc): pass the last item's `startedAt` and `studySessionId` back as
 * `beforeStartedAt` / `beforeId`. A read.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { videoId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const q = request.nextUrl.searchParams;
  const roundParam = q.get("roundId");
  const limit = Number(q.get("limit") ?? 10);
  const beforeStartedAt = q.get("beforeStartedAt");
  const beforeId = q.get("beforeId");
  const roundless = roundParam === "none";
  const cursorOk =
    (beforeStartedAt === null && beforeId === null) ||
    (beforeStartedAt !== null && !Number.isNaN(Date.parse(beforeStartedAt)) && isUuid(beforeId));
  if (
    !isVideoId(videoId) ||
    (!roundless && !isUuid(roundParam)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !cursorOk
  ) {
    return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("fn_history_video_sessions", {
    p_video: videoId,
    p_round_id: roundless ? null : roundParam,
    p_roundless: roundless,
    p_limit: limit,
    p_before_started_at: beforeStartedAt,
    p_before_id: beforeId,
  });
  if (error || !data) return mapLearningReadError(error, "history/videos/sessions", "042");
  return NextResponse.json(data as HistoryVideoSessionsPage);
}
