import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data: sessions, error: sessionsError } = await supabase
      .from("learning_sessions")
      .select("id, youtube_video_id, status, accuracy, video_current_time, updated_at")
      .eq("user_id", user.id);

    if (sessionsError) {
      console.error("[dashboard] sessions query error:", sessionsError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }

    const completedSessions = (sessions ?? []).filter((s) => s.status === "completed");
    const completedVideos = new Set(completedSessions.map((s) => s.youtube_video_id)).size;
    const avgAccuracy =
      completedSessions.length > 0
        ? Math.round(
            completedSessions.reduce((sum, s) => sum + Number(s.accuracy ?? 0), 0) /
              completedSessions.length
          )
        : 0;
    const totalPracticeMinutes = Math.round(
      ((sessions ?? []).reduce((sum, s) => sum + Number(s.video_current_time ?? 0), 0) || 0) /
        60
    );
    const sessionIds = (sessions ?? []).map((s) => s.id);

    const { data: mistakes, error: mistakesError } = sessionIds.length
      ? await supabase
          .from("attempt_logs")
          .select("id, expected_text, user_text, error_type, created_at, segment_index, session_id")
          .in("session_id", sessionIds)
          .eq("is_correct", false)
          .order("created_at", { ascending: false })
          .limit(6)
      : { data: [], error: null };

    if (mistakesError) {
      console.error("[dashboard] mistakes query error:", mistakesError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }

    const { data: vocabulary, error: vocabularyError } = await supabase
      .from("vocabulary_items")
      .select("id, term, sentence_context, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(6);

    if (vocabularyError) {
      console.error("[dashboard] vocabulary query error:", vocabularyError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }

    const { count: vocabularyCount, error: vocabularyCountError } = await supabase
      .from("vocabulary_items")
      .select("id", { head: true, count: "exact" })
      .eq("user_id", user.id);

    if (vocabularyCountError) {
      console.error("[dashboard] vocabulary count error:", vocabularyCountError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }

    const activeSessions = (sessions ?? [])
      .filter((s) => s.status === "active")
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, 4)
      .map((s) => ({
        videoId: s.youtube_video_id,
        updatedAt: s.updated_at,
      }));

    return NextResponse.json({
      completedVideos,
      avgAccuracy,
      totalPracticeMinutes,
      vocabularyCount: vocabularyCount ?? 0,
      recentMistakes: mistakes ?? [],
      recentVocabulary: vocabulary ?? [],
      resumableSessions: activeSessions,
    });
  } catch (err) {
    console.error("[dashboard] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
