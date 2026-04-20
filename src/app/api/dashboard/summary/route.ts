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
      .select(
        "id, youtube_video_id, status, accuracy, video_current_time, updated_at, current_segment_index, total_attempts"
      )
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
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    const latestSessionByVideoId = new Map<string, (typeof activeSessions)[number]>();
    for (const session of activeSessions) {
      if (!latestSessionByVideoId.has(session.youtube_video_id)) {
        latestSessionByVideoId.set(session.youtube_video_id, session);
      }
    }
    const recentSessions = [...latestSessionByVideoId.values()].slice(0, 4);
    const recentVideoIds = [...new Set(recentSessions.map((s) => s.youtube_video_id))];
    const recentSessionIds = recentSessions.map((s) => s.id);

    const { data: recentVideos, error: recentVideosError } = recentVideoIds.length
      ? await supabase
          .from("videos")
          .select("youtube_video_id, title")
          .in("youtube_video_id", recentVideoIds)
      : { data: [], error: null };

    if (recentVideosError) {
      console.error("[dashboard] recent videos query error:", recentVideosError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }

    const { data: recentMistakeAttempts, error: recentMistakeAttemptsError } = recentSessionIds.length
      ? await supabase
          .from("attempt_logs")
          .select("session_id")
          .in("session_id", recentSessionIds)
          .eq("is_correct", false)
      : { data: [], error: null };

    if (recentMistakeAttemptsError) {
      console.error("[dashboard] recent mistakes count query error:", recentMistakeAttemptsError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }

    const titleByVideoId = new Map(
      (recentVideos ?? []).map((video) => [video.youtube_video_id, video.title])
    );
    const mistakeCountBySessionId = (recentMistakeAttempts ?? []).reduce<Record<string, number>>(
      (acc, attempt) => {
        acc[attempt.session_id] = (acc[attempt.session_id] ?? 0) + 1;
        return acc;
      },
      {}
    );

    const resumableSessions = recentSessions.map((session) => ({
      sessionId: session.id,
      videoId: session.youtube_video_id,
      videoTitle: titleByVideoId.get(session.youtube_video_id) ?? null,
      updatedAt: session.updated_at,
      accuracy: Number(session.accuracy ?? 0),
      currentSegmentIndex: Number(session.current_segment_index ?? 0),
      totalAttempts: Number(session.total_attempts ?? 0),
      mistakesCount: mistakeCountBySessionId[session.id] ?? 0,
    }));

    return NextResponse.json({
      completedVideos,
      avgAccuracy,
      totalPracticeMinutes,
      vocabularyCount: vocabularyCount ?? 0,
      recentVocabulary: vocabulary ?? [],
      resumableSessions,
    });
  } catch (err) {
    console.error("[dashboard] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
