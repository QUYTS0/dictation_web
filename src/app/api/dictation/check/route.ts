import { NextRequest, NextResponse } from "next/server";
import { checkAnswer } from "@/lib/utils/text";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ownsSession } from "@/lib/supabase/ownership";
import type {
  CheckAnswerRequest,
  CheckAnswerResponse,
  MatchMode,
} from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const body: CheckAnswerRequest = await request.json();
    const {
      sessionId,
      segmentIndex,
      userText,
      expectedText,
      matchMode = "relaxed",
    } = body;

    if (typeof userText !== "string" || typeof expectedText !== "string") {
      return NextResponse.json(
        { error: "userText and expectedText are required strings." },
        { status: 400 }
      );
    }

    if (typeof segmentIndex !== "number") {
      return NextResponse.json(
        { error: "segmentIndex must be a number." },
        { status: 400 }
      );
    }

    const validModes: MatchMode[] = ["exact", "relaxed", "learning"];
    const mode: MatchMode = validModes.includes(matchMode as MatchMode)
      ? (matchMode as MatchMode)
      : "relaxed";

    const result = checkAnswer(expectedText, userText, mode);

    console.log(
      `[dictation/check] segmentIndex=${segmentIndex} mode=${mode} isCorrect=${result.isCorrect} errorType=${result.errorType}`
    );

    // Persist the attempt if we have a session that the caller actually owns.
    // Checking an answer never requires ownership — only persisting it does —
    // so an unowned/unauthenticated sessionId just skips the insert below.
    if (sessionId) {
      const authClient = await createClient();
      const {
        data: { user },
      } = await authClient.auth.getUser();
      const owned = user ? await ownsSession(authClient, user.id, sessionId) : false;

      if (owned) {
        try {
          // Phase 2: delegates to fn_legacy_record_dictation_attempt
          // (migration 035), called via the SAME service-role client as
          // before — identical insert shape, now gate-aware
          // (write_gate_paused). Ownership was already verified above
          // using the caller's own RLS-respecting client; session_id is
          // passed as an already-trusted parameter, unchanged from today.
          const serviceClient = createServiceClient();
          const { error: rpcError } = await serviceClient.rpc("fn_legacy_record_dictation_attempt", {
            p_session_id: sessionId,
            p_segment_index: segmentIndex,
            p_expected_text: expectedText,
            p_user_text: userText,
            p_normalized_expected_text: result.normalizedExpected,
            p_normalized_user_text: result.normalizedUser,
            p_is_correct: result.isCorrect,
            p_error_type: result.errorType === "none" ? null : result.errorType,
          });
          if (rpcError) {
            // Non-fatal — log and continue, exactly like the previous raw
            // .insert()'s try/catch: a persistence failure (including a
            // paused write gate) never blocks returning the grading
            // result to the client.
            console.error("[dictation/check] attempt log error:", rpcError);
          }
        } catch (dbErr) {
          // Non-fatal — log and continue
          console.error("[dictation/check] attempt log error:", dbErr);
        }
      } else {
        console.warn(
          `[dictation/check] skipped attempt log — sessionId=${sessionId} not owned by caller`
        );
      }
    }

    const response: CheckAnswerResponse = {
      ...result,
      sessionId,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[dictation/check] unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
