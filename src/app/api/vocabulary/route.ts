import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeVocabularyTerm } from "@/lib/utils/vocabulary";
import type { VocabularyItem, VocabularyRequest } from "@/lib/types";

export async function GET(request: NextRequest) {
  try {
    const videoId = request.nextUrl.searchParams.get("videoId");
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    let query = supabase
      .from("vocabulary_items")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (videoId) {
      query = query.eq("video_id", videoId);
    }

    const { data, error } = await query;
    if (error) {
      console.error("[vocabulary] list error:", error);
      return NextResponse.json({ error: "Failed to fetch vocabulary" }, { status: 500 });
    }

    return NextResponse.json({ items: (data ?? []) as VocabularyItem[] });
  } catch (err) {
    console.error("[vocabulary] unexpected GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: VocabularyRequest = await request.json();
    const { videoId, segmentIndex, term, sentenceContext, note } = body;

    if (!videoId || typeof segmentIndex !== "number" || !term || !sentenceContext) {
      return NextResponse.json(
        { error: "videoId, segmentIndex, term and sentenceContext are required" },
        { status: 400 }
      );
    }

    const normalizedTerm = normalizeVocabularyTerm(term);
    if (!normalizedTerm) {
      return NextResponse.json({ error: "term cannot be empty" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const dedupeFilter = {
      user_id: user.id,
      video_id: videoId,
      segment_index: segmentIndex,
      normalized_term: normalizedTerm,
    };

    const { data: existing, error: existingError } = await supabase
      .from("vocabulary_items")
      .select("id")
      .match(dedupeFilter)
      .maybeSingle();

    if (existingError) {
      console.error("[vocabulary] dedupe query error:", existingError);
      return NextResponse.json({ error: "Failed to save vocabulary item" }, { status: 500 });
    }

    const payload = {
      ...dedupeFilter,
      term: term.trim(),
      sentence_context: sentenceContext.trim(),
      note: note?.trim() || null,
    };

    let data;
    let error;
    if (existing) {
      const result = await supabase
        .from("vocabulary_items")
        .update(payload)
        .eq("id", existing.id)
        .select("*")
        .single();
      data = result.data;
      error = result.error;
    } else {
      const result = await supabase.from("vocabulary_items").insert(payload).select("*").single();
      data = result.data;
      error = result.error;
    }

    if (error || !data) {
      console.error("[vocabulary] save error:", error);
      return NextResponse.json({ error: "Failed to save vocabulary item" }, { status: 500 });
    }

    return NextResponse.json({ item: data as VocabularyItem });
  } catch (err) {
    console.error("[vocabulary] unexpected POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("vocabulary_items")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id");

    if (error) {
      console.error("[vocabulary] delete error:", error);
      return NextResponse.json({ error: "Failed to delete vocabulary item" }, { status: 500 });
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Vocabulary item not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[vocabulary] unexpected DELETE error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      id?: string;
      term?: string;
      sentenceContext?: string;
      note?: string | null;
    };
    const { id, term, sentenceContext, note } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
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
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingError) {
      console.error("[vocabulary] PATCH existing query error:", existingError);
      return NextResponse.json({ error: "Failed to update vocabulary item" }, { status: 500 });
    }

    if (!existing) {
      return NextResponse.json({ error: "Vocabulary item not found" }, { status: 404 });
    }

    const nextTerm = (term ?? existing.term).trim();
    const nextSentenceContext = (sentenceContext ?? existing.sentence_context).trim();
    const normalizedTerm = normalizeVocabularyTerm(nextTerm);
    if (!normalizedTerm) {
      return NextResponse.json({ error: "term cannot be empty" }, { status: 400 });
    }
    if (!nextSentenceContext) {
      return NextResponse.json({ error: "sentenceContext cannot be empty" }, { status: 400 });
    }

    const payload = {
      term: nextTerm,
      normalized_term: normalizedTerm,
      sentence_context: nextSentenceContext,
      note:
        note === undefined
          ? existing.note
          : typeof note === "string"
          ? note.trim() || null
          : null,
    };

    const { data, error } = await supabase
      .from("vocabulary_items")
      .update(payload)
      .eq("id", id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error || !data) {
      console.error("[vocabulary] PATCH update error:", error);
      if (error?.code === "23505") {
        return NextResponse.json({ error: "A matching vocabulary item already exists." }, { status: 409 });
      }
      return NextResponse.json({ error: "Failed to update vocabulary item" }, { status: 500 });
    }

    return NextResponse.json({ item: data as VocabularyItem });
  } catch (err) {
    console.error("[vocabulary] unexpected PATCH error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
