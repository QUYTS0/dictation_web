import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import type { ErrorType, SessionAssessment, SessionReportMistake, SessionReportResponse } from "@/lib/types";
import type { RoundReport } from "@/lib/types/learning";
import { buildDictationEvidence } from "@/lib/practice/dictationAnalysis";
import { resolveExplanations, type ExplanationAttempt, type StoredExplanation } from "@/lib/practice/explanationIdentity";

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

    // The whole-round report (fn_round_report, migration 040): every metric
    // across ALL study sessions of this round and its pinned revision — the
    // same contract the practice page's completion view uses.
    const [
      { data: video, error: videoError },
      { count: totalSegments, error: segmentsError },
      { data: attempts, error: attemptsError },
      { data: roundReport, error: roundReportError },
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
        .select("id, segment_index, expected_text, user_text, is_correct, error_type, created_at, is_practice_valid, match_mode")
        .eq("session_id", sessionId)
        .order("segment_index", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase.rpc("fn_round_report", { p_round_id: sessionId }),
    ]);

    if (roundReportError || !roundReport) return mapLearningReadError(roundReportError, "session/report");

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

    // Learning Reports P4: saved explanations (attempt_explanations — new
    // notes plus copies of every legacy ai_feedback row), read through the
    // owner RLS policy. Read-only: no provider call, no write. Each sentence
    // shows its answer's own note, else the same mistake's note from another
    // sentence of THIS round (mode-aware key), else an earlier answer's note
    // (historical). A failed read leaves the deterministic report intact.
    let explanationsUnavailable = false;
    if (mistakes.length > 0) {
      const { data: savedNotes, error: notesError } = await supabase
        .from("attempt_explanations")
        .select("id, attempt_id, source, seq, explanation, corrected_text, example_text, tip, prompt_version, model, created_at")
        .eq("round_id", sessionId);
      if (notesError) {
        console.error("[session/report] attempt_explanations query error:", notesError);
        explanationsUnavailable = true;
      } else if ((savedNotes ?? []).length > 0) {
        const roundAttempts = (attempts ?? []) as ExplanationAttempt[];
        const byId = new Map(roundAttempts.map((a) => [a.id, a]));
        const shown = mistakes.map((m) => byId.get(m.attemptId)).filter((a): a is ExplanationAttempt => !!a);
        const resolved = resolveExplanations(shown, roundAttempts, (savedNotes ?? []) as StoredExplanation[]);
        for (const mistake of mistakes) {
          const r = resolved.get(mistake.attemptId);
          if (!r) continue;
          mistake.aiFeedback = {
            explanation: r.explanation,
            correctedText: r.correctedText,
            example: r.example,
            ...(r.tip ? { tip: r.tip } : {}),
            via: r.via,
            ...(r.viaSegmentIndex !== undefined ? { viaSegmentIndex: r.viaSegmentIndex } : {}),
            historical: r.historical,
            legacy: r.legacy,
          };
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

    // Learning Reports P2: a round that isn't the active one names the
    // video's active round (if any) — its report then offers "Go to current
    // round" instead of continuing an old round. Read-only.
    let newerActiveRound: { roundId: string; roundNumber: number } | null = null;
    if (session.status !== "active") {
      const { data: act, error: activeError } = await supabase
        .from("learning_sessions")
        .select("id, round_number")
        .eq("user_id", user.id)
        .eq("youtube_video_id", session.youtube_video_id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (activeError) console.error("[session/report] active round query error:", activeError);
      const a = act as { id: string; round_number: number | null } | null;
      if (a && a.id !== session.id) newerActiveRound = { roundId: a.id, roundNumber: a.round_number ?? 0 };
    }

    // Learning Reports P3 (read-only): the pinned script's version number,
    // and Listening — stored per video + script version, plus what this
    // round's own sittings newly covered.
    let transcriptVersion: number | null = null;
    let listening: SessionReportResponse["listening"] = null;
    if (session.transcript_id) {
      const [{ data: tv }, { data: lp, error: lpError }, { data: sittings, error: sittingsError }] = await Promise.all([
        supabase.from("transcripts").select("version").eq("id", session.transcript_id).maybeSingle(),
        supabase
          .from("listening_progress")
          .select("coverage_ratio, listened_through, last_position_sec")
          .eq("user_id", user.id)
          .eq("youtube_video_id", session.youtube_video_id)
          .eq("transcript_id", session.transcript_id)
          .maybeSingle(),
        supabase
          .from("study_sessions")
          .select("listening_newly_covered_sec, listening_observed_sec")
          .eq("user_id", user.id)
          .eq("round_id", session.id),
      ]);
      transcriptVersion = (tv as { version: number | null } | null)?.version ?? null;
      if (lpError || sittingsError) console.error("[session/report] listening query error:", lpError ?? sittingsError);
      const row = lp as { coverage_ratio: number | string | null; listened_through: boolean; last_position_sec: number | string | null } | null;
      const rows = (sittings ?? []) as Array<{ listening_newly_covered_sec: number | string; listening_observed_sec: number | string }>;
      const newly = rows.reduce((sum, r) => sum + Number(r.listening_newly_covered_sec ?? 0), 0);
      const observed = rows.reduce((sum, r) => sum + Number(r.listening_observed_sec ?? 0), 0);
      if (row || observed > 0) {
        listening = {
          coverageRatio: row && row.coverage_ratio !== null ? Number(row.coverage_ratio) : null,
          listenedThrough: row?.listened_through ?? false,
          lastPositionSec: row && row.last_position_sec !== null ? Number(row.last_position_sec) : null,
          roundSittingsNewlyCoveredSec: newly,
          roundSittingsObservedSec: observed,
        };
      }
    }

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
      round: roundReport as RoundReport,
      // Read-only, derived from the rows already loaded above.
      dictationEvidence: buildDictationEvidence(attempts ?? []),
      newerActiveRound,
      ...(explanationsUnavailable ? { explanationsUnavailable: true } : {}),
      transcriptVersion,
      listening,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[session/report] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
