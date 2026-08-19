import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Bookmark, BookmarkRequest } from "@/lib/types";

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
      .from("bookmarks")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (videoId) {
      query = query.eq("video_id", videoId);
    }

    const { data, error } = await query;
    if (error) {
      console.error("[bookmarks] list error:", error);
      return NextResponse.json({ error: "Failed to fetch bookmarks" }, { status: 500 });
    }

    const rows = (data ?? []) as Bookmark[];
    const videoIds = [...new Set(rows.map((row) => row.video_id))];
    const { data: videos, error: videosError } = videoIds.length
      ? await supabase.from("videos").select("youtube_video_id, title").in("youtube_video_id", videoIds)
      : { data: [], error: null };

    if (videosError) {
      console.error("[bookmarks] videos query error:", videosError);
      return NextResponse.json({ error: "Failed to fetch bookmarks" }, { status: 500 });
    }

    const titleByVideoId = new Map((videos ?? []).map((v) => [v.youtube_video_id, v.title]));
    const items = rows.map((row) => ({ ...row, videoTitle: titleByVideoId.get(row.video_id) ?? null }));

    return NextResponse.json({ items });
  } catch (err) {
    console.error("[bookmarks] unexpected GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: BookmarkRequest = await request.json();
    const { videoId, segmentIndex, startSec, sentenceText, note } = body;

    if (!videoId || typeof segmentIndex !== "number" || typeof startSec !== "number" || !sentenceText) {
      return NextResponse.json(
        { error: "videoId, segmentIndex, startSec and sentenceText are required" },
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

    const dedupeFilter = {
      user_id: user.id,
      video_id: videoId,
      segment_index: segmentIndex,
    };

    const { data: existing, error: existingError } = await supabase
      .from("bookmarks")
      .select("id")
      .match(dedupeFilter)
      .maybeSingle();

    if (existingError) {
      console.error("[bookmarks] dedupe query error:", existingError);
      return NextResponse.json({ error: "Failed to save bookmark" }, { status: 500 });
    }

    const payload = {
      ...dedupeFilter,
      start_sec: startSec,
      sentence_text: sentenceText.trim(),
      note: note?.trim() || null,
    };

    let data;
    let error;
    if (existing) {
      const result = await supabase
        .from("bookmarks")
        .update(payload)
        .eq("id", existing.id)
        .select("*")
        .single();
      data = result.data;
      error = result.error;
    } else {
      const result = await supabase.from("bookmarks").insert(payload).select("*").single();
      data = result.data;
      error = result.error;
    }

    if (error || !data) {
      console.error("[bookmarks] save error:", error);
      return NextResponse.json({ error: "Failed to save bookmark" }, { status: 500 });
    }

    return NextResponse.json({ item: data as Bookmark });
  } catch (err) {
    console.error("[bookmarks] unexpected POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { id?: string; note?: string | null };
    const { id, note } = body;

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
      .from("bookmarks")
      .update({ note: typeof note === "string" ? note.trim() || null : null })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error || !data) {
      console.error("[bookmarks] PATCH update error:", error);
      return NextResponse.json({ error: "Failed to update bookmark" }, { status: 500 });
    }

    return NextResponse.json({ item: data as Bookmark });
  } catch (err) {
    console.error("[bookmarks] unexpected PATCH error:", err);
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
      .from("bookmarks")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id");

    if (error) {
      console.error("[bookmarks] delete error:", error);
      return NextResponse.json({ error: "Failed to delete bookmark" }, { status: 500 });
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Bookmark not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[bookmarks] unexpected DELETE error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
