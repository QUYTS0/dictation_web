import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import { loadActivityStreak, viewerTimeZoneFrom } from "@/lib/supabase/activityStreak";
import type { DashboardSummary } from "@/lib/types/learning";

/**
 * Account-wide Dashboard metrics (plan §6.8), computed by the database
 * (fn_dashboard_summary, migration 040) — each metric separate, never
 * blended, missing values null rather than zero:
 *   completedVideos        distinct videos with a VERIFIED completed round
 *   legacyCompletedVideos  distinct videos whose only completions are
 *                          earlier (unverified) ones — never double-counted
 *   inProgressVideos       distinct videos with an active round that has
 *                          practice (may overlap completedVideos)
 *   listenedThroughVideos  separate from practice completion
 *   sentenceAccuracy       latest verified answer per (round, sentence),
 *                          across rounds — with its denominator
 *   shadowing              Azure and Word Match, each only from its own
 *                          saved results
 *   activeTime             union of engaged wall-clock intervals across ALL
 *                          study sessions (overlap counted once) — an
 *                          estimate, only since tracking started
 *   streakDays             consecutive calendar days with practice in any
 *                          mode, counted back from the viewer's local today
 *                          (`?tz=`) — the SAME loader as /api/streak, so the
 *                          practice header and the Dashboard always agree
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    const [summary, streak, { data: vocabulary, error: vocabularyError }, { count: vocabularyCount, error: vocabularyCountError }] =
      await Promise.all([
        supabase.rpc("fn_dashboard_summary"),
        loadActivityStreak(supabase, viewerTimeZoneFrom(request.url)),
        supabase
          .from("vocabulary_items")
          .select("id, term, sentence_context, created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(6),
        supabase.from("vocabulary_items").select("id", { head: true, count: "exact" }).eq("user_id", user.id),
      ]);

    if (summary.error || !summary.data) return mapLearningReadError(summary.error, "dashboard");
    if (!streak.ok) return streak.response;
    if (vocabularyError || vocabularyCountError) {
      console.error("[dashboard] vocabulary query error:", vocabularyError ?? vocabularyCountError);
      return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
    }

    const body: DashboardSummary = {
      ...(summary.data as Omit<DashboardSummary, "vocabularyCount" | keyof typeof streak.streak | "recentVocabulary">),
      vocabularyCount: vocabularyCount ?? 0,
      ...streak.streak,
      recentVocabulary: vocabulary ?? [],
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error("[dashboard] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
