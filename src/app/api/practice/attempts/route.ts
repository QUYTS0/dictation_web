import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapPracticeEvaluationError } from "@/lib/supabase/practiceEvaluationErrors";
import { isUuid } from "@/lib/practice/validation";
import type { ShadowingRoundResults } from "@/lib/practice/shadowingTypes";

/**
 * GET /api/practice/attempts?roundId= — the saved Shadowing state of ONE
 * round, bounded by that round: per practiced sentence the latest attempt,
 * the latest successful Azure attempt and the latest Word Match attempt
 * (independent, chronological), plus at most five compact Azure results for
 * the trend. Lets a reloaded page restore results without any local attempt
 * id and without calling Azure. Owner-only through RLS; a round of another
 * user is simply not found. Historical rounds are readable too — the caller
 * decides where to show them.
 */
export async function GET(request: NextRequest) {
  try {
    const roundId = request.nextUrl.searchParams.get("roundId");
    if (!isUuid(roundId)) {
      return NextResponse.json({ error: "roundId (UUID) is required.", code: "invalid_payload" }, { status: 400 });
    }
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const { data, error } = await supabase.rpc("fn_shadowing_round_results", { p_round_id: roundId });
    if (error || !data) return mapPracticeEvaluationError(error, "Failed to load saved recordings.");
    return NextResponse.json(data as ShadowingRoundResults);
  } catch (err) {
    console.error("[practice/attempts] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
