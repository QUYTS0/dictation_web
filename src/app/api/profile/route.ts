import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import type { UserProfile, UserProfilePatch } from "@/lib/types/profile";

const PATCH_KEYS = new Set<keyof UserProfilePatch>(["publicName", "dailyGoalMinutes", "leaderboardHidden"]);

/**
 * The signed-in learner's preferences (migration 047): daily goal, and the
 * public name / leaderboard visibility the boards use from Phase 7.
 *   GET    fn_my_profile
 *   PATCH  fn_update_my_profile — only the keys sent change; null clears a
 *          name or goal. The database validates every value (and its CHECK
 *          constraints back that up), so the rules live in one place;
 *          anything it refuses is a 400 and nothing is changed.
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    const { data, error } = await supabase.rpc("fn_my_profile");
    if (error || !data) return mapLearningReadError(error, "profile", "047");
    return NextResponse.json(data as UserProfile);
  } catch (err) {
    console.error("[profile] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length === 0 ||
      !Object.keys(body).every((k) => PATCH_KEYS.has(k as keyof UserProfilePatch))
    ) {
      return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("fn_update_my_profile", { p_patch: body });
    if (error || !data) return mapLearningReadError(error, "profile", "047");
    return NextResponse.json(data as UserProfile);
  } catch (err) {
    console.error("[profile] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
