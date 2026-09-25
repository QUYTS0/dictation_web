import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { checkAnswer, wordDiff } from "@/lib/utils/text";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ownsSession } from "@/lib/supabase/ownership";
import { mapLegacyBridgeError } from "@/lib/supabase/legacyBridgeErrors";
import { mapPracticeWriteError } from "@/lib/supabase/practiceWriteErrors";
import { getPracticeWritePath } from "@/lib/practice/writePath";
import type { CheckAnswerRequest, CheckAnswerResponse, ErrorType, MatchMode, RoundProgress } from "@/lib/types";

const VALID_MODES: MatchMode[] = ["exact", "relaxed", "learning"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RecordResult {
  attemptId: string;
  wasInserted: boolean;
  isCorrect: boolean;
  errorType: ErrorType;
  /** The grading mode stored with the attempt (same as requested — a different mode on a reused id is a 409). */
  matchMode?: MatchMode | null;
  normalizedExpected: string;
  normalizedUser: string;
  studySessionId: string | null;
  roundCompletedByThisRequest: boolean;
  roundStatus: "active" | "completed" | "abandoned";
  progress: RoundProgress;
}

/**
 * Grades a Dictation answer and — for a signed-in user practicing a round —
 * records it.
 *
 * Recorded answers (a round `sessionId` + a signed-in caller):
 *   authoritative — fn_record_dictation_attempt, called with the caller's
 *     OWN client: the function verifies the round belongs to the caller
 *     (and video), checks the transcript pin, resolves the reference text
 *     from the pinned segment, and grades it itself (parity with
 *     src/lib/utils/text.ts is verified on real PostgreSQL). The client's
 *     expectedText is ignored. One `clientAttemptId` per logical submission
 *     makes retries idempotent; requests from old tabs without one get a
 *     server-generated id (such requests cannot be deduplicated across
 *     retries — documented limitation).
 *   legacy (preparation release) — the Phase 2 bridge.
 * In BOTH paths a failed save is an error response (503 + retryable while
 * maintenance pauses writes) — never a successful grade that silently
 * wasn't saved, so the client keeps the answer and does not advance.
 *
 * Unrecorded answers (guest, or no round yet) are graded with the same
 * TypeScript logic against the client's expectedText and marked
 * `recorded: false`.
 */
export async function POST(request: NextRequest) {
  try {
    const body: CheckAnswerRequest = await request.json();
    const { sessionId, segmentIndex, userText, expectedText, matchMode = "relaxed" } = body;

    if (typeof userText !== "string") {
      return NextResponse.json({ error: "userText is required." }, { status: 400 });
    }
    if (typeof segmentIndex !== "number" || !Number.isInteger(segmentIndex) || segmentIndex < 0) {
      return NextResponse.json({ error: "segmentIndex must be a non-negative integer." }, { status: 400 });
    }
    const mode: MatchMode = VALID_MODES.includes(matchMode as MatchMode) ? (matchMode as MatchMode) : "relaxed";

    let clientAttemptId = body.clientAttemptId;
    if (clientAttemptId !== undefined && (typeof clientAttemptId !== "string" || !UUID_RE.test(clientAttemptId))) {
      return NextResponse.json({ error: "clientAttemptId must be a UUID." }, { status: 400 });
    }
    const hint = body.hintLevelUsed;
    if (hint !== undefined && hint !== null && !(Number.isInteger(hint) && hint >= 0 && hint <= 4)) {
      return NextResponse.json({ error: "hintLevelUsed must be an integer between 0 and 4." }, { status: 400 });
    }

    const authClient = sessionId ? await createClient() : null;
    const user = authClient ? (await authClient.auth.getUser()).data.user : null;

    if (!sessionId || !authClient || !user) {
      if (typeof expectedText !== "string") {
        return NextResponse.json({ error: "expectedText is required for unrecorded checks." }, { status: 400 });
      }
      const result = checkAnswer(expectedText, userText, mode);
      return NextResponse.json<CheckAnswerResponse>({ ...result, sessionId, recorded: false });
    }

    if (getPracticeWritePath() === "legacy") {
      if (typeof expectedText !== "string") {
        return NextResponse.json({ error: "expectedText is required." }, { status: 400 });
      }
      const result = checkAnswer(expectedText, userText, mode);
      const owned = await ownsSession(authClient, user.id, sessionId);
      if (!owned) {
        console.warn(`[dictation/check] not recorded — sessionId=${sessionId} not owned by caller`);
        return NextResponse.json<CheckAnswerResponse>({ ...result, sessionId, recorded: false });
      }
      const serviceClient = createServiceClient();
      const { error } = await serviceClient.rpc("fn_legacy_record_dictation_attempt", {
        p_session_id: sessionId,
        p_segment_index: segmentIndex,
        p_expected_text: expectedText,
        p_user_text: userText,
        p_normalized_expected_text: result.normalizedExpected,
        p_normalized_user_text: result.normalizedUser,
        p_is_correct: result.isCorrect,
        p_error_type: result.errorType === "none" ? null : result.errorType,
      });
      if (error) return mapLegacyBridgeError(error, "Failed to save your answer");
      return NextResponse.json<CheckAnswerResponse>({ ...result, sessionId, recorded: true });
    }

    const idempotency = clientAttemptId ? "client" : "server_generated";
    clientAttemptId = clientAttemptId ?? randomUUID();
    const { data, error } = await authClient.rpc("fn_record_dictation_attempt", {
      p_round_id: sessionId,
      p_youtube_video_id: body.youtubeVideoId ?? null,
      p_segment_index: segmentIndex,
      p_client_attempt_id: clientAttemptId,
      p_user_text: userText,
      p_match_mode: mode,
      p_transcript_id: body.transcriptId ?? null,
      p_study_session_id: body.studySessionId ?? null,
      p_hint_level_used: hint ?? null,
    });
    if (error || !data) return mapPracticeWriteError(authClient, error, "Failed to save your answer");

    const r = data as RecordResult;
    console.log(
      `[dictation/check] round=${sessionId} seg=${segmentIndex} correct=${r.isCorrect} inserted=${r.wasInserted} idempotency=${idempotency}`
    );
    return NextResponse.json<CheckAnswerResponse>({
      isCorrect: r.isCorrect,
      matchMode: r.matchMode ?? mode,
      errorType: r.errorType,
      // Display-only diff, from the database's own normalized strings.
      diff: wordDiff(r.normalizedExpected.split(" ").filter(Boolean), r.normalizedUser.split(" ").filter(Boolean)),
      normalizedExpected: r.normalizedExpected,
      normalizedUser: r.normalizedUser,
      sessionId,
      recorded: true,
      attemptId: r.attemptId,
      clientAttemptId,
      wasInserted: r.wasInserted,
      roundCompletedByThisRequest: r.roundCompletedByThisRequest,
      roundStatus: r.roundStatus,
      progress: r.progress,
      coverage: r.progress.coverage,
      studySessionId: r.studySessionId,
    });
  } catch (err) {
    console.error("[dictation/check] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
