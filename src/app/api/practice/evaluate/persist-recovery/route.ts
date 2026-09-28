import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mapPracticeEvaluationError } from "@/lib/supabase/practiceEvaluationErrors";
import { getRecoverySecret, verifyRecoveryToken } from "@/lib/practice/recoveryToken";
import { finishAzureCompleted } from "@/lib/practice/azureEvaluation";

/**
 * Writes an Azure result the evaluate route obtained but could not store
 * (plan §9.4). Accepts ONLY the opaque server-signed token — never score
 * values — and never calls Azure. The token must be intact (HMAC), unexpired,
 * issued to the signed-in user, and still for the attempt's current request
 * seq (fn_finish_azure_evaluation enforces ownership and seq in SQL). A
 * repeated valid recovery is reported as already saved, with no second write.
 */
export async function POST(request: NextRequest) {
  const secret = getRecoverySecret();
  if (!secret) {
    return NextResponse.json(
      { error: "Result recovery isn't configured.", code: "evaluation_not_configured" },
      { status: 503 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  let token: unknown;
  try {
    token = (await request.json())?.recoveryToken;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const verified = verifyRecoveryToken(secret, token);
  if (!verified.ok) {
    if (verified.reason === "expired") {
      return NextResponse.json(
        { error: "This result can no longer be saved. Evaluate a new recording.", code: "recovery_token_expired" },
        { status: 410 }
      );
    }
    return NextResponse.json({ error: "Invalid recovery token.", code: "invalid_recovery_token" }, { status: 400 });
  }
  const { payload } = verified;
  if (payload.userId !== user.id) {
    return NextResponse.json({ error: "This result belongs to another account.", code: "recovery_account_mismatch" }, { status: 403 });
  }

  const { data, error } = await finishAzureCompleted(
    createServiceClient(),
    { attemptId: payload.attemptId, userId: user.id, seq: payload.seq },
    payload.result
  );
  if (error || !data) return mapPracticeEvaluationError(error, "Couldn't save the result yet. Please try again.");

  if (data.outcome === "applied" || data.outcome === "already_applied") {
    return NextResponse.json({ persisted: true, attemptId: payload.attemptId, seq: payload.seq, alreadySaved: data.outcome === "already_applied" });
  }
  if (data.outcome === "conflict") {
    // A different result is already stored for this request; it is kept.
    return NextResponse.json(
      { error: "A different result is already saved for this recording.", code: "recovery_conflict", attemptId: payload.attemptId },
      { status: 409 }
    );
  }
  return NextResponse.json(
    {
      error: "A newer evaluation of this recording replaced this result.",
      code: "recovery_superseded",
      attemptId: payload.attemptId,
    },
    { status: 409 }
  );
}
