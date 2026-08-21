import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeStreakDays } from "@/lib/utils/streak";

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
    const allSessionIds = (sessions ?? []).map((s) => s.id);
    // Latest session per video regardless of status — a video whose most
    // recent session is "completed" must still surface (as completed) here,
    // otherwise reopening it silently creates a fresh "active" row that then
    // looks like abandoned progress. See resumableSessions' `status` field,
    // which callers use to route to /results (completed) vs /dictation (active).
    const sortedSessions = [...(sessions ?? [])].sort(
      (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
    );
    const latestSessionByVideoId = new Map<string, (typeof sortedSessions)[number]>();
    for (const session of sortedSessions) {
      if (!latestSessionByVideoId.has(session.youtube_video_id)) {
        latestSessionByVideoId.set(session.youtube_video_id, session);
      }
    }
    const recentSessions = [...latestSessionByVideoId.values()].slice(0, 10);
    const recentVideoIds = [...new Set(recentSessions.map((s) => s.youtube_video_id))];
    const recentSessionIds = recentSessions.map((s) => s.id);

    // None of these depend on each other's results (only on `sessions`,
    // already resolved above) — run them concurrently instead of awaiting
    // one at a time, which was turning every dashboard load into a 5-deep
    // waterfall of round-trips.
    const [
      { data: activityAttempts, error: activityAttemptsError },
      { data: vocabulary, error: vocabularyError },
      { count: vocabularyCount, error: vocabularyCountError },
      { data: recentVideos, error: recentVideosError },
      { data: recentMistakeAttempts, error: recentMistakeAttemptsError },
    ] = await Promise.all([
      allSessionIds.length
        ? supabase.from("attempt_logs").select("created_at").in("session_id", allSessionIds)
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from("vocabulary_items")
        .select("id, term, sentence_context, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(6),
      supabase.from("vocabulary_items").select("id", { head: true, count: "exact" }).eq("user_id", user.id),
      recentVideoIds.length
        ? supabase.from("videos").select("youtube_video_id, title").in("youtube_video_id", recentVideoIds)
        : Promise.resolve({ data: [], error: null }),
      recentSessionIds.length
        ? supabase
            .from("attempt_logs")
            .select("session_id")
            .in("session_id", recentSessionIds)
            .eq("is_correct", false)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (activityAttemptsError) {
      console.error("[dashboard] activity attempts query error:", activityAttemptsError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }
    if (vocabularyError) {
      console.error("[dashboard] vocabulary query error:", vocabularyError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }
    if (vocabularyCountError) {
      console.error("[dashboard] vocabulary count error:", vocabularyCountError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }
    if (recentVideosError) {
      console.error("[dashboard] recent videos query error:", recentVideosError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }
    if (recentMistakeAttemptsError) {
      console.error("[dashboard] recent mistakes count query error:", recentMistakeAttemptsError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }

    const streakDays = computeStreakDays(
      (activityAttempts ?? []).map((a) => new Date(a.created_at))
    );

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
      status: session.status as "active" | "completed" | "abandoned",
    }));

    return NextResponse.json({
      completedVideos,
      avgAccuracy,
      totalPracticeMinutes,
      vocabularyCount: vocabularyCount ?? 0,
      streakDays,
      recentVocabulary: vocabulary ?? [],
      resumableSessions,
    });
  } catch (err) {
    console.error("[dashboard] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
