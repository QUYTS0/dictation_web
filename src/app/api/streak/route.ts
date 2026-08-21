import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeStreakDays } from "@/lib/utils/streak";

/**
 * Lightweight streak-only endpoint (vs. the heavier /api/dashboard/summary)
 * so pages like Dictation Mode can surface the daily streak without paying
 * for the vocabulary/recent-videos/mistakes queries that page doesn't need.
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data: attempts, error } = await supabase
      .from("attempt_logs")
      .select("created_at, learning_sessions!inner(user_id)")
      .eq("learning_sessions.user_id", user.id);

    if (error) {
      console.error("[streak] query error:", error);
      return NextResponse.json({ error: "Failed to load streak" }, { status: 500 });
    }

    const streakDays = computeStreakDays((attempts ?? []).map((a) => new Date(a.created_at)));

    return NextResponse.json({ streakDays });
  } catch (err) {
    console.error("[streak] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
