import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mapPracticeEvaluationError } from "@/lib/supabase/practiceEvaluationErrors";
import { isUuid } from "@/lib/practice/validation";
import type { ShadowingAttemptDto } from "@/lib/practice/shadowingTypes";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

/**
 * One saved Shadowing attempt with its stored evaluation results (plan
 * §9.1) — lets a page learn how an evaluation ended after navigating away.
 * Read through the caller's own RLS (fn_get_shadowing_attempt is SECURITY
 * INVOKER). A pending evaluation past the timeout is reported as
 * failed/'expired' and, lazily, recorded as such — only for that exact
 * request seq, so a newer request is never expired by this read.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
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

    const { data, error } = await supabase.rpc("fn_get_shadowing_attempt", { p_attempt_id: attemptId });
    if (error || !data) return mapPracticeEvaluationError(error, "Failed to load the recording.");
    const attempt = data as ShadowingAttemptDto;

    if (attempt.azure.status === "failed" && attempt.azure.errorReason === "expired") {
      const { error: expireError } = await createServiceClient().rpc("fn_expire_azure_evaluation", {
        p_attempt_id: attemptId,
        p_user_id: user.id,
        p_seq: attempt.azure.seq,
      });
      if (expireError) console.warn("[practice/attempt] lazy expiry failed:", expireError.message);
    }
    return NextResponse.json(attempt);
  } catch (err) {
    console.error("[practice/attempt] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
