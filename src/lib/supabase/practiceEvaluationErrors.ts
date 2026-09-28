import { NextResponse } from "next/server";
import type { PracticeRpcError } from "./practiceWriteErrors";

/**
 * Maps errors from the Phase 4 evaluation functions (migration 038) to
 * HTTP responses. Every RAISE there uses a plain, stable message.
 */
const CONFLICTS: Record<string, string> = {
  audio_duration_mismatch: "This audio doesn't match the saved recording. Record the sentence again.",
  attempt_relationship_invalid: "This recording no longer matches its lesson. Please reload the page.",
  reference_unavailable: "This sentence can't be evaluated. Please reload the page.",
  attempt_not_evaluable: "This recording is too short to evaluate. Record the sentence again.",
  azure_already_evaluated: "This recording has already been evaluated.",
  word_match_already_recorded: "Word Match for this recording was already saved.",
};

export function mapPracticeEvaluationError(error: PracticeRpcError | null | undefined, fallback: string): NextResponse {
  const message = error?.message ?? "";
  if (message === "authentication_required") {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (message === "attempt_not_found") {
    return NextResponse.json({ error: "Recording not found.", code: "attempt_not_found" }, { status: 404 });
  }
  if (message === "round_not_found") {
    return NextResponse.json({ error: "Practice round not found.", code: "round_not_found" }, { status: 404 });
  }
  if (message === "audio_invalid") {
    return NextResponse.json({ error: "That recording couldn't be read. Record the sentence again.", code: "audio_invalid" }, { status: 400 });
  }
  if (message === "invalid_payload") {
    return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
  }
  if (message in CONFLICTS) {
    return NextResponse.json({ error: CONFLICTS[message], code: message }, { status: 409 });
  }
  if (error?.code === "PGRST202" || error?.code === "42883") {
    // Phase 4 code deployed before migration 038 was applied.
    console.error("[practiceEvaluation] evaluation function missing — is migration 038 applied?", error);
    return NextResponse.json(
      { error: "Evaluation saving isn't available yet.", code: "evaluation_unavailable" },
      { status: 503 }
    );
  }
  console.error("[practiceEvaluation] RPC error:", error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
