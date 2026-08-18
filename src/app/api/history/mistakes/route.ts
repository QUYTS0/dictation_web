import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface MistakeRow {
  id: string;
  session_id: string;
  segment_index: number;
  expected_text: string;
  user_text: string;
  error_type: string | null;
  created_at: string;
  learning_sessions: { youtube_video_id: string } | { youtube_video_id: string }[] | null;
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const videoId = params.get("videoId");
    const errorType = params.get("errorType");
    const dateFrom = params.get("dateFrom");
    const dateTo = params.get("dateTo");
    const limit = Math.min(Number(params.get("limit")) || DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(Number(params.get("offset")) || 0, 0);

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    let query = supabase
      .from("attempt_logs")
      .select(
        "id, session_id, segment_index, expected_text, user_text, error_type, created_at, learning_sessions!inner(youtube_video_id)",
        { count: "exact" }
      )
      .eq("is_correct", false)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (videoId) {
      query = query.eq("learning_sessions.youtube_video_id", videoId);
    }
    if (errorType) {
      query = query.eq("error_type", errorType);
    }
    if (dateFrom) {
      query = query.gte("created_at", dateFrom);
    }
    if (dateTo) {
      query = query.lte("created_at", dateTo);
    }

    const { data, count, error } = await query;

    if (error) {
      console.error("[history/mistakes] query error:", error);
      return NextResponse.json({ error: "Failed to load mistakes" }, { status: 500 });
    }

    const rows = (data ?? []) as unknown as MistakeRow[];

    const videoIds = [
      ...new Set(
        rows
          .map((row) => (Array.isArray(row.learning_sessions) ? row.learning_sessions[0] : row.learning_sessions)?.youtube_video_id)
          .filter((id): id is string => Boolean(id))
      ),
    ];

    const { data: videos, error: videosError } = videoIds.length
      ? await supabase.from("videos").select("youtube_video_id, title").in("youtube_video_id", videoIds)
      : { data: [], error: null };

    if (videosError) {
      console.error("[history/mistakes] videos query error:", videosError);
      return NextResponse.json({ error: "Failed to load mistakes" }, { status: 500 });
    }

    const titleByVideoId = new Map((videos ?? []).map((v) => [v.youtube_video_id, v.title]));

    const items = rows.map((row) => {
      const session = Array.isArray(row.learning_sessions) ? row.learning_sessions[0] : row.learning_sessions;
      const rowVideoId = session?.youtube_video_id ?? "";
      return {
        id: row.id,
        sessionId: row.session_id,
        videoId: rowVideoId,
        videoTitle: titleByVideoId.get(rowVideoId) ?? null,
        segmentIndex: row.segment_index,
        expectedText: row.expected_text,
        userText: row.user_text,
        errorType: row.error_type,
        createdAt: row.created_at,
      };
    });

    return NextResponse.json({
      items,
      hasMore: offset + items.length < (count ?? 0),
      total: count ?? 0,
    });
  } catch (err) {
    console.error("[history/mistakes] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
