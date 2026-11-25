import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isRecordedErrorType } from "@/lib/constants/errorTypes";
import type { DashboardMistakeExample } from "@/lib/types/learning";

interface AttemptRow {
  id: string;
  expected_text: string;
  user_text: string;
  created_at: string;
  learning_sessions: { youtube_video_id: string } | { youtube_video_id: string }[] | null;
}

/**
 * The learner's latest recorded mistake of one type, for the Dashboard's
 * diagnostics panel (dashboard redesign Phase 3). Same row set as
 * GET /api/dashboard/error-patterns (incorrect attempts with that
 * error_type), so the example always belongs to a counted bar. Includes the
 * attempt's SAVED explanation when one exists — read-only: this route never
 * asks the AI for a new one.
 */
export async function GET(request: NextRequest) {
  try {
    const errorType = request.nextUrl.searchParams.get("errorType");
    if (!isRecordedErrorType(errorType)) {
      return NextResponse.json({ error: "A valid errorType is required." }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    const { data, error } = await supabase
      .from("attempt_logs")
      .select("id, expected_text, user_text, created_at, learning_sessions!inner(youtube_video_id)")
      .eq("is_correct", false)
      .eq("error_type", errorType)
      .eq("learning_sessions.user_id", user.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("[dashboard/mistake-example] query error:", error);
      return NextResponse.json({ error: "Failed to load an example" }, { status: 500 });
    }
    if (!data) return NextResponse.json({ example: null });

    const row = data as unknown as AttemptRow;
    const videoId = (Array.isArray(row.learning_sessions) ? row.learning_sessions[0] : row.learning_sessions)?.youtube_video_id ?? null;

    // The attempt's effective saved note: first by (seq desc nulls last,
    // created_at desc, id desc) — the rule documented in migration 043.
    const [explanationResult, videoResult] = await Promise.all([
      supabase
        .from("attempt_explanations")
        .select("explanation")
        .eq("attempt_id", row.id)
        .order("seq", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle(),
      videoId ? supabase.from("videos").select("title").eq("youtube_video_id", videoId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);
    // Both are optional decorations: a failure leaves them out, never the example.
    if (explanationResult.error) console.error("[dashboard/mistake-example] explanation query error:", explanationResult.error);
    if (videoResult.error) console.error("[dashboard/mistake-example] video query error:", videoResult.error);

    const example: DashboardMistakeExample = {
      attemptId: row.id,
      expectedText: row.expected_text,
      userText: row.user_text,
      createdAt: row.created_at,
      videoId,
      videoTitle: (videoResult.data as { title: string | null } | null)?.title ?? null,
      explanation: (explanationResult.data as { explanation: string } | null)?.explanation ?? null,
    };
    return NextResponse.json({ example });
  } catch (err) {
    console.error("[dashboard/mistake-example] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
