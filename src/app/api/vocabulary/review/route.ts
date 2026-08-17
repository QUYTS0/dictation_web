import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeNextReview, type ReviewGrade } from "@/lib/utils/srs";
import type { VocabularyItem, VocabularyReviewSubmitRequest } from "@/lib/types";

const REVIEW_BATCH_SIZE = 20;
const VALID_GRADES: ReviewGrade[] = ["again", "hard", "good", "easy"];

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
    const { itemId, grade } = body;

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

    const { data, error } = await supabase
      .from("vocabulary_items")
      .update({
        interval_days: next.intervalDays,
        ease_factor: next.easeFactor,
        repetitions: next.repetitions,
        next_review_at: next.nextReviewAt.toISOString(),
        last_reviewed_at: now.toISOString(),
      })
      .eq("id", itemId)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error || !data) {
      console.error("[vocabulary/review] update error:", error);
      return NextResponse.json({ error: "Failed to update review state" }, { status: 500 });
    }

    return NextResponse.json({ item: data as VocabularyItem });
  } catch (err) {
    console.error("[vocabulary/review] unexpected POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
