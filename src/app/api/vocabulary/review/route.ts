import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import { computeNextReview, type ReviewGrade } from "@/lib/utils/srs";
import { isValidTimeZone } from "@/lib/utils/streak";
import type { VocabularyItem, VocabularyReviewSubmitRequest } from "@/lib/types";

const REVIEW_BATCH_SIZE = 20;
const VALID_GRADES: ReviewGrade[] = ["again", "hard", "good", "easy"];

/**
 * DEFERRED (product decision, not yet designed): this ordering is purely
 * `next_review_at ASC` across New and Due items together — it does not
 * prioritize Due over New, nor interleave New into a Due-first queue. The
 * intended behavior is Due-first with New items mixed in at some TBD
 * ratio/algorithm; that design is a separate follow-up, not implemented
 * here. Until it lands, the Vocabulary Bank's review hero deliberately does
 * not claim this ordering exists (see `deriveHeroState`'s own comment in
 * src/app/vocabulary/page.tsx) — update that copy in lockstep with whatever
 * ships here.
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

    const { data, error } = await supabase
      .from("vocabulary_items")
      .select("*")
      .eq("user_id", user.id)
      .lte("next_review_at", new Date().toISOString())
      .order("next_review_at", { ascending: true })
      .limit(REVIEW_BATCH_SIZE);

    if (error) {
      console.error("[vocabulary/review] list error:", error);
      return NextResponse.json({ error: "Failed to fetch due vocabulary items" }, { status: 500 });
    }

    return NextResponse.json({ items: (data ?? []) as VocabularyItem[] });
  } catch (err) {
    console.error("[vocabulary/review] unexpected GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: VocabularyReviewSubmitRequest = await request.json();
    const { itemId, grade, timeZone } = body;

    if (!itemId || !VALID_GRADES.includes(grade)) {
      return NextResponse.json(
        { error: "itemId and a valid grade (again/hard/good/easy) are required" },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data: existing, error: existingError } = await supabase
      .from("vocabulary_items")
      .select("interval_days, ease_factor, repetitions")
      .eq("id", itemId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingError) {
      console.error("[vocabulary/review] fetch error:", existingError);
      return NextResponse.json({ error: "Failed to update review state" }, { status: 500 });
    }

    if (!existing) {
      return NextResponse.json({ error: "Vocabulary item not found" }, { status: 404 });
    }

    const now = new Date();
    const next = computeNextReview(
      {
        intervalDays: existing.interval_days,
        easeFactor: existing.ease_factor,
        repetitions: existing.repetitions,
      },
      grade,
      now
    );

    // One transaction: the item's SRS update + its vocabulary_reviews row
    // (migration 046), so a review always counts toward the streak exactly
    // once. The review's day is decided in the viewer's timezone; an absent
    // or invalid zone is stored as null (UTC fallback), never an error.
    const { data, error } = await supabase.rpc("fn_record_vocabulary_review", {
      p_item_id: itemId,
      p_grade: grade,
      p_interval_days: next.intervalDays,
      p_ease_factor: next.easeFactor,
      p_repetitions: next.repetitions,
      p_next_review_at: next.nextReviewAt.toISOString(),
      p_time_zone: isValidTimeZone(timeZone) ? timeZone : null,
    });

    if (error) return mapLearningReadError(error, "vocabulary/review", "046");
    // null: the item vanished (or changed owner) between the read and the write.
    if (!data) return NextResponse.json({ error: "Vocabulary item not found" }, { status: 404 });

    return NextResponse.json({ item: data as VocabularyItem });
  } catch (err) {
    console.error("[vocabulary/review] unexpected POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
