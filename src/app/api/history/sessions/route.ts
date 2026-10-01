import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/practice/validation";
import { isVideoId, mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import type { HistorySessionsPage } from "@/lib/types/learning";

/**
 * The caller's study sessions, newest first (fn_history_sessions, 040).
 * Keyset pagination: pass the last item's `startedAt` and `studySessionId`
 * back as `beforeStartedAt` / `beforeId`.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const limit = Number(params.get("limit") ?? 10);
  const beforeStartedAt = params.get("beforeStartedAt");
  const beforeId = params.get("beforeId");
  const videoId = params.get("videoId") || null;
  const cursorOk =
    (beforeStartedAt === null && beforeId === null) ||
    (beforeStartedAt !== null && !Number.isNaN(Date.parse(beforeStartedAt)) && isUuid(beforeId));
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !cursorOk || (videoId !== null && !isVideoId(videoId))) {
    return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("fn_history_sessions", {
    p_limit: limit,
    p_before_started_at: beforeStartedAt,
    p_before_id: beforeId,
    p_video: videoId,
  });
  if (error || !data) return mapLearningReadError(error, "history/sessions");
  return NextResponse.json(data as HistorySessionsPage);
}
