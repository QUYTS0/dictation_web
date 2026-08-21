import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ErrorType, SessionAssessment, SessionReportMistake, SessionReportResponse } from "@/lib/types";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { sessionId } = await params;
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data: session, error: sessionError } = await supabase
      .from("learning_sessions")
      .select(
        "id, youtube_video_id, transcript_id, status, accuracy, total_attempts, current_segment_index, started_at, updated_at"
      )
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (sessionError) {
      console.error("[session/report] session query error:", sessionError);
      return NextResponse.json({ error: "Failed to load session" }, { status: 500 });
    }
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const [
      { data: video, error: videoError },
      { count: totalSegments, error: segmentsError },
      { data: attempts, error: attemptsError },
    ] = await Promise.all([
      supabase
        .from("videos")
        .select("title")
        .eq("youtube_video_id", session.youtube_video_id)
        .maybeSingle(),
      session.transcript_id
        ? supabase
            .from("transcript_segments")
            .select("id", { head: true, count: "exact" })
            .eq("transcript_id", session.transcript_id)
        : Promise.resolve({ count: null, error: null }),
      supabase
        .from("attempt_logs")
        .select("id, segment_index, expected_text, user_text, is_correct, error_type, created_at")
        .eq("session_id", sessionId)
        .order("segment_index", { ascending: true })
        .order("created_at", { ascending: true }),
    ]);

    if (videoError) {
      console.error("[session/report] video query error:", videoError);
      return NextResponse.json({ error: "Failed to load session" }, { status: 500 });
    }
    if (segmentsError) {
      console.error("[session/report] segments count error:", segmentsError);
      return NextResponse.json({ error: "Failed to load session" }, { status: 500 });
    }
    if (attemptsError) {
      console.error("[session/report] attempts query error:", attemptsError);
      return NextResponse.json({ error: "Failed to load session" }, { status: 500 });
    }

    const wrongAttempts = (attempts ?? []).filter((a) => !a.is_correct);

    const mistakesBySegment = new Map<number, SessionReportMistake>();
    for (const attempt of wrongAttempts) {
      const existing = mistakesBySegment.get(attempt.segment_index);
      if (existing) {
        existing.attempts += 1;
        existing.userText = attempt.user_text;
        existing.errorType = (attempt.error_type as ErrorType | null) ?? existing.errorType;
        existing.attemptId = attempt.id;
      } else {
        mistakesBySegment.set(attempt.segment_index, {
          segmentIndex: attempt.segment_index,
          expectedText: attempt.expected_text,
          userText: attempt.user_text,
          errorType: (attempt.error_type as ErrorType | null) ?? null,
          attempts: 1,
          attemptId: attempt.id,
          aiFeedback: null,
        });
      }
    }
    const mistakes = [...mistakesBySegment.values()].sort((a, b) => a.segmentIndex - b.segmentIndex);

    // Preload any AI explanations already generated for these attempts (via
    // a previous "Explain all" run on this report) so they show immediately
    // instead of requiring another click.
    if (mistakes.length > 0) {
      const { data: cachedFeedback, error: feedbackError } = await supabase
        .from("ai_feedback")
        .select("attempt_id, explanation, corrected_text, example_text")
        .in(
          "attempt_id",
          mistakes.map((m) => m.attemptId)
        );

      if (feedbackError) {
        console.error("[session/report] ai_feedback query error:", feedbackError);
      } else {
        const feedbackByAttemptId = new Map((cachedFeedback ?? []).map((f) => [f.attempt_id, f]));
        for (const mistake of mistakes) {
          const feedback = feedbackByAttemptId.get(mistake.attemptId);
          if (feedback) {
            mistake.aiFeedback = {
              explanation: feedback.explanation ?? "",
              correctedText: feedback.corrected_text ?? mistake.expectedText,
              example: feedback.example_text ?? "",
            };
          }
        }
      }
    }

    const errorCounts = new Map<string, number>();
    for (const attempt of wrongAttempts) {
      if (!attempt.error_type) continue;
      errorCounts.set(attempt.error_type, (errorCounts.get(attempt.error_type) ?? 0) + 1);
    }
    const errorTotal = [...errorCounts.values()].reduce((sum, count) => sum + count, 0);
    const errorBreakdown = [...errorCounts.entries()]
      .map(([errorType, count]) => ({
        errorType: errorType as ErrorType,
        count,
        percentage: errorTotal > 0 ? Math.round((count / errorTotal) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    const durationSec = Math.max(
      0,
      Math.round((Date.parse(session.updated_at) - Date.parse(session.started_at)) / 1000)
    );

    // Fetched separately (not in the main session select above) so that if
    // the 010_session_assessment migration hasn't been applied yet, this
    // report still loads fine with assessment: null instead of a hard 500.
    let assessment: SessionAssessment | null = null;
    let assessmentGeneratedAt: string | null = null;
    const { data: assessmentRow, error: assessmentError } = await supabase
      .from("learning_sessions")
      .select("ai_assessment, ai_assessment_generated_at")
      .eq("id", sessionId)
      .maybeSingle();
    if (assessmentError) {
      console.warn(
        "[session/report] ai_assessment query error (migration 010 may not be applied yet):",
        assessmentError
      );
    } else if (assessmentRow?.ai_assessment) {
      assessment = assessmentRow.ai_assessment as SessionAssessment;
      assessmentGeneratedAt = assessmentRow.ai_assessment_generated_at ?? null;
    }

    const response: SessionReportResponse = {
      session: {
        id: session.id,
        videoId: session.youtube_video_id,
        videoTitle: video?.title ?? null,
        status: session.status as "active" | "completed" | "abandoned",
        accuracy: Number(session.accuracy ?? 0),
        totalAttempts: session.total_attempts ?? 0,
        currentSegmentIndex: session.current_segment_index ?? 0,
        totalSegments: totalSegments ?? null,
        startedAt: session.started_at,
        updatedAt: session.updated_at,
        durationSec,
        assessment,
        assessmentGeneratedAt,
      },
      errorBreakdown,
      mistakes,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[session/report] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
