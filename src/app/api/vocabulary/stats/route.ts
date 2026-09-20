import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { VocabularyStatsResponse } from "@/lib/types";

/**
 * Exact-count aggregates for the Vocabulary Bank header + review-session
 * badge. Deliberately its own endpoint rather than folded into
 * GET /api/vocabulary's response: these counts must stay correct even if
 * that list fetch is ever capped/paginated (PostgREST's default row cap is
 * not configured anywhere in this repo, so it can't be assumed unbounded),
 * and keeping them separate lets the card grid and the stat header load/
 * error independently instead of one blocking the other.
 *
 * new/learning/due mirror getVocabularyLearningStatus's precedence exactly
 * (src/lib/utils/vocabulary.ts) — see that function's comment for why
 * last_reviewed_at, not next_review_at or repetitions, is the required
 * "ever reviewed" signal. Keep the two in lockstep if either changes.
 *
 * `reviewable` mirrors GET /api/vocabulary/review's own admission filter
 * (next_review_at <= now(), regardless of last_reviewed_at) exactly — see
 * isVocabularyItemReviewable's comment for why this is computed
 * independently rather than as `new + due` on the client. It's the same
 * predicate, just without the (currently coincidental) `new` overlap.
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

    const nowIso = new Date().toISOString();

    const [
      { count: total, error: totalError },
      { count: newCount, error: newError },
      { count: dueCount, error: dueError },
      { count: learningCount, error: learningError },
      { count: reviewableCount, error: reviewableError },
    ] = await Promise.all([
      supabase.from("vocabulary_items").select("id", { head: true, count: "exact" }).eq("user_id", user.id),
      supabase
        .from("vocabulary_items")
        .select("id", { head: true, count: "exact" })
        .eq("user_id", user.id)
        .is("last_reviewed_at", null),
      supabase
        .from("vocabulary_items")
        .select("id", { head: true, count: "exact" })
        .eq("user_id", user.id)
        .not("last_reviewed_at", "is", null)
        .lte("next_review_at", nowIso),
      supabase
        .from("vocabulary_items")
        .select("id", { head: true, count: "exact" })
        .eq("user_id", user.id)
        .not("last_reviewed_at", "is", null)
        .gt("next_review_at", nowIso),
      // Same admission filter as GET /api/vocabulary/review — no
      // last_reviewed_at condition at all, unlike the `due` count above.
      supabase
        .from("vocabulary_items")
        .select("id", { head: true, count: "exact" })
        .eq("user_id", user.id)
        .lte("next_review_at", nowIso),
    ]);

    const firstError = totalError ?? newError ?? dueError ?? learningError ?? reviewableError;
    if (firstError) {
      console.error("[vocabulary/stats] query error:", firstError);
      return NextResponse.json({ error: "Failed to load vocabulary stats" }, { status: 500 });
    }

    const response: VocabularyStatsResponse = {
      total: total ?? 0,
      new: newCount ?? 0,
      due: dueCount ?? 0,
      learning: learningCount ?? 0,
      reviewable: reviewableCount ?? 0,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[vocabulary/stats] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
