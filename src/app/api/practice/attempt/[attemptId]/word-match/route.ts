import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mapPracticeEvaluationError } from "@/lib/supabase/practiceEvaluationErrors";
import { isUuid } from "@/lib/practice/validation";
import { computeWordMatch, MAX_RECOGNIZED_TEXT_LENGTH } from "@/lib/practice/wordMatch";
import type { WordMatchStatus, WordMatchSubmitResponse } from "@/lib/practice/shadowingTypes";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

const STATUSES: WordMatchStatus[] = ["completed", "failed", "unsupported"];

/**
 * Stores the Word Match result of a saved recording (plan §9.1), independent
 * of Azure (own status, own word_match_request_seq, own failures).
 *
 * Trust boundary (documented in PHASE4_RUNBOOK.md): Word Match is built on
 * the BROWSER's speech recognition of the live mic stream, so the recognized
 * text is client-derived by design — no server-side transcription service
 * exists and none is added. The scores, however, are never accepted from the
 * client: they are recomputed here from that text against the attempt's own
 * pinned sentence, with the same algorithm the page uses.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { attemptId } = await params;
    if (!isUuid(attemptId)) {
      return NextResponse.json({ error: "Invalid attemptId.", code: "invalid_payload" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    let body: { status?: unknown; recognizedText?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    const status = body.status as WordMatchStatus;
    if (!STATUSES.includes(status)) {
      return NextResponse.json({ error: "status must be completed, failed or unsupported.", code: "invalid_payload" }, { status: 400 });
    }
    const recognizedText = body.recognizedText;
    if (
      status === "completed" &&
      (typeof recognizedText !== "string" || recognizedText.length > MAX_RECOGNIZED_TEXT_LENGTH)
    ) {
      return NextResponse.json({ error: "recognizedText is required.", code: "invalid_payload" }, { status: 400 });
    }

    // Owner RLS: another user's attempt is simply not found.
    const { data: attempt, error: attemptError } = await supabase
      .from("shadowing_attempts")
      .select("id, segment_id, transcript_id, segment_index")
      .eq("id", attemptId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (attemptError) return mapPracticeEvaluationError(attemptError, "Failed to save Word Match.");
    if (!attempt) return mapPracticeEvaluationError({ message: "attempt_not_found" }, "");

    let accuracy: number | null = null;
    let completeness: number | null = null;
    let detail: Record<string, unknown> | null = null;
    let problemWords: WordMatchSubmitResponse["problemWords"] = [];
    if (status === "completed") {
      const { data: segment, error: segmentError } = attempt.segment_id
        ? await supabase
            .from("transcript_segments")
            .select("text_raw, transcript_id, segment_index")
            .eq("id", attempt.segment_id)
            .maybeSingle()
        : { data: null, error: null };
      if (segmentError) return mapPracticeEvaluationError(segmentError, "Failed to save Word Match.");
      if (!segment || segment.transcript_id !== attempt.transcript_id || segment.segment_index !== attempt.segment_index) {
        return mapPracticeEvaluationError({ message: "reference_unavailable" }, "");
      }
      const scores = computeWordMatch(segment.text_raw, recognizedText as string);
      accuracy = scores.accuracy;
      completeness = scores.completeness;
      problemWords = scores.problemWords;
      detail = { recognizedText, problemWords };
    }

    const { data, error } = await createServiceClient().rpc("fn_record_word_match", {
      p_attempt_id: attemptId,
      p_user_id: user.id,
      p_status: status,
      p_accuracy: accuracy,
      p_completeness: completeness,
      p_detail: detail,
    });
    if (error || !data) return mapPracticeEvaluationError(error, "Failed to save Word Match.");
    const r = data as { applied: boolean; seq: number; status: WordMatchStatus };
    return NextResponse.json<WordMatchSubmitResponse>({
      attemptId,
      status: r.status,
      seq: r.seq,
      applied: r.applied,
      accuracy,
      completeness,
      problemWords,
    });
  } catch (err) {
    console.error("[practice/word-match] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
