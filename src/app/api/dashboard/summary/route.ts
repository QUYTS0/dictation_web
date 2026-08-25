import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeStreakDays } from "@/lib/utils/streak";
import type { ResumableSession } from "@/lib/types";

interface UnifiedSessionRow {
  id: string;
  mode: "dictation" | "listening";
  youtube_video_id: string;
  status: "active" | "completed" | "abandoned";
  updated_at: string;
  video_current_time: number;
  accuracy?: number;
  current_segment_index?: number;
  total_attempts?: number;
}

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    // Dictation (learning_sessions) and Listening (listening_sessions) are
    // separate tables — see 012_listening_sessions.sql for why — so both are
    // queried and merged here, tagged with `mode`, rather than one query.
    const [{ data: dictationRows, error: dictationError }, { data: listeningRows, error: listeningError }] =
      await Promise.all([
        supabase
          .from("learning_sessions")
          .select(
            "id, youtube_video_id, status, accuracy, video_current_time, updated_at, current_segment_index, total_attempts"
          )
          .eq("user_id", user.id),
        supabase
          .from("listening_sessions")
          .select("id, youtube_video_id, status, video_current_time, updated_at")
          .eq("user_id", user.id),
      ]);

    if (dictationError) {
      console.error("[dashboard] dictation sessions query error:", dictationError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }
    // Non-fatal: if 012_listening_sessions.sql hasn't been applied yet, degrade
    // to dictation-only data instead of breaking the whole dashboard for it.
    if (listeningError) {
      console.error("[dashboard] listening sessions query error (continuing without listening data):", listeningError);
    }

    const sessions: UnifiedSessionRow[] = [
      ...(dictationRows ?? []).map((s) => ({ ...s, mode: "dictation" as const })),
      ...(listeningRows ?? []).map((s) => ({ ...s, mode: "listening" as const })),
    ];

    // Grading stats (completed-video count, average accuracy) are inherently
    // a dictation concept — listening has no correct/incorrect notion.
    const completedDictationSessions = (dictationRows ?? []).filter((s) => s.status === "completed");
    const completedVideos = new Set(completedDictationSessions.map((s) => s.youtube_video_id)).size;
    const avgAccuracy =
      completedDictationSessions.length > 0
        ? Math.round(
            completedDictationSessions.reduce((sum, s) => sum + Number(s.accuracy ?? 0), 0) /
              completedDictationSessions.length
          )
        : 0;
    // Practice time, on the other hand, is mode-agnostic — both count as
    // time spent with the video.
    const totalPracticeMinutes = Math.round(
      (sessions.reduce((sum, s) => sum + Number(s.video_current_time ?? 0), 0) || 0) / 60
    );
    const allDictationSessionIds = (dictationRows ?? []).map((s) => s.id);
    // Latest session per (mode, video) regardless of status — a video whose
    // most recent session is "completed" must still surface (as completed)
    // here, otherwise reopening it silently creates a fresh "active" row
    // that then looks like abandoned progress. See resumableSessions'
    // `status` field, which callers use to route to /results (dictation,
    // completed) vs /dictation or /listening (active). Dictation and
    // listening progress on the same video are tracked separately, so both
    // can appear.
    const sortedSessions = [...sessions].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    const latestSessionByKey = new Map<string, UnifiedSessionRow>();
    for (const session of sortedSessions) {
      const key = `${session.mode}:${session.youtube_video_id}`;
      if (!latestSessionByKey.has(key)) {
        latestSessionByKey.set(key, session);
      }
    }
    const recentSessions = [...latestSessionByKey.values()].slice(0, 10);
    const recentVideoIds = [...new Set(recentSessions.map((s) => s.youtube_video_id))];
    // attempt_logs only ever references learning_sessions rows — scoping to
    // dictation ids keeps the mistakes-count query from being sent listening
    // session ids it could never match anyway.
    const recentDictationSessionIds = recentSessions
      .filter((s) => s.mode === "dictation")
      .map((s) => s.id);

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
      allDictationSessionIds.length
        ? supabase.from("attempt_logs").select("created_at").in("session_id", allDictationSessionIds)
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
      recentDictationSessionIds.length
        ? supabase
            .from("attempt_logs")
            .select("session_id")
            .in("session_id", recentDictationSessionIds)
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

    const resumableSessions: ResumableSession[] = recentSessions.map((session) => {
      const base = {
        sessionId: session.id,
        mode: session.mode,
        videoId: session.youtube_video_id,
        videoTitle: titleByVideoId.get(session.youtube_video_id) ?? null,
        updatedAt: session.updated_at,
        status: session.status,
      };
      if (session.mode === "dictation") {
        return {
          ...base,
          accuracy: Number(session.accuracy ?? 0),
          currentSegmentIndex: Number(session.current_segment_index ?? 0),
          totalAttempts: Number(session.total_attempts ?? 0),
          mistakesCount: mistakeCountBySessionId[session.id] ?? 0,
        };
      }
      return { ...base, videoCurrentTimeSec: Number(session.video_current_time ?? 0) };
    });

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
