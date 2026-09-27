import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapPracticeWriteError } from "@/lib/supabase/practiceWriteErrors";
import { isUuid } from "@/lib/practice/validation";
import type { RoundProgress } from "@/lib/types";
import type { RecordShadowingAttemptRequest, RecordShadowingAttemptResponse } from "@/lib/practice/shadowingTypes";

interface RecordResult {
  attemptId: string;
  wasInserted: boolean;
  isPracticeValid: boolean;
  studySessionId: string | null;
  roundCompletedByThisRequest: boolean;
  roundStatus: "active" | "completed" | "abandoned";
  progress: RoundProgress;
}

/**
 * Records one finished Shadowing recording as practice (plan §9.3), before
 * and independently of any evaluation. Only metadata is sent — never audio.
 *
 * Everything that matters is decided by fn_record_shadowing_attempt with the
 * caller's own identity: round/video/pin/segment relationships, practice
 * validity (duration-based, validity_basis 'client_reported' — it does not
 * prove speech was verified), idempotency on (round, clientAttemptId),
 * study-session attribution (including none for a superseded round),
 * completion and the write gate. When the page has no round yet, the
 * active round is created/resolved first by the same authoritative
 * function Dictation uses, so both modes share one round.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    let body: Partial<RecordShadowingAttemptRequest>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    const { youtubeVideoId, roundId, transcriptId, segmentIndex, clientAttemptId, recordingDurationSec, studySessionId } = body;
    if (
      typeof youtubeVideoId !== "string" ||
      !youtubeVideoId.trim() ||
      !isUuid(transcriptId) ||
      !isUuid(clientAttemptId) ||
      typeof segmentIndex !== "number" ||
      !Number.isInteger(segmentIndex) ||
      segmentIndex < 0 ||
      typeof recordingDurationSec !== "number" ||
      !Number.isFinite(recordingDurationSec) ||
      recordingDurationSec < 0 ||
      recordingDurationSec > 600 ||
      (roundId != null && !isUuid(roundId)) ||
      (studySessionId != null && !isUuid(studySessionId))
    ) {
      return NextResponse.json(
        {
          error:
            "youtubeVideoId, transcriptId, segmentIndex, clientAttemptId (UUID) and recordingDurationSec (0–600) are required.",
          code: "invalid_payload",
        },
        { status: 400 }
      );
    }

    let resolvedRoundId = roundId ?? null;
    if (!resolvedRoundId) {
      const { data, error } = await supabase.rpc("fn_create_or_get_active_round", {
        p_youtube_video_id: youtubeVideoId,
        p_expected_transcript_id: transcriptId,
      });
      if (error || !data) return mapPracticeWriteError(supabase, error, "Failed to save your recording");
      resolvedRoundId = (data as { roundId: string }).roundId;
    }

    const { data, error } = await supabase.rpc("fn_record_shadowing_attempt", {
      p_round_id: resolvedRoundId,
      p_youtube_video_id: youtubeVideoId,
      p_segment_index: segmentIndex,
      p_client_attempt_id: clientAttemptId,
      p_recording_duration_sec: recordingDurationSec,
      p_transcript_id: transcriptId,
      p_study_session_id: studySessionId ?? null,
    });
    if (error || !data) return mapPracticeWriteError(supabase, error, "Failed to save your recording");

    const r = data as RecordResult;
    console.log(
      `[practice/attempt] round=${resolvedRoundId} seg=${segmentIndex} valid=${r.isPracticeValid} inserted=${r.wasInserted} completed=${r.roundCompletedByThisRequest}`
    );
    return NextResponse.json<RecordShadowingAttemptResponse>({
      attemptId: r.attemptId,
      clientAttemptId: clientAttemptId as string,
      roundId: resolvedRoundId,
      wasInserted: r.wasInserted,
      isPracticeValid: r.isPracticeValid,
      studySessionId: r.studySessionId,
      roundCompletedByThisRequest: r.roundCompletedByThisRequest,
      roundStatus: r.roundStatus,
      progress: r.progress,
      coverage: r.progress.coverage,
    });
  } catch (err) {
    console.error("[practice/attempt] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
