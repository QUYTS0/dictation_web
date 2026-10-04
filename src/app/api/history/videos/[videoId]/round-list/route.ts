import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isVideoId } from "@/lib/supabase/learningReadErrors";
import type { VideoRoundList } from "@/lib/types/learning";

interface RouteParams {
  params: Promise<{ videoId: string }>;
}

const MAX_LIMIT = 100;

/**
 * Every round of ONE video for the signed-in user, for the report page's
 * round selector: newest first (started_at desc, id desc — the History
 * order), paged by offset, with the exact total so the page never presents
 * a loaded page as "all rounds". Owner-only (RLS learning_sessions_owner_select
 * plus the explicit user filter). A plain read: no RPC, no writes.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { videoId } = await params;
  if (!isVideoId(videoId)) return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });

  const q = request.nextUrl.searchParams;
  const offset = Math.max(0, Math.floor(Number(q.get("offset") ?? 0)) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(q.get("limit") ?? 50)) || 50));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data, error, count } = await supabase
    .from("learning_sessions")
    .select("id, round_number, status, provenance, started_at, transcript_id", { count: "exact" })
    .eq("user_id", user.id)
    .eq("youtube_video_id", videoId)
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    console.error("[history/videos/round-list] query error:", error);
    return NextResponse.json({ error: "Failed to load rounds" }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    id: string;
    round_number: number | null;
    status: "active" | "completed" | "abandoned";
    provenance: "current" | "legacy_unverified" | null;
    started_at: string;
    transcript_id: string | null;
  }>;
  const total = count ?? offset + rows.length;
  const body: VideoRoundList = {
    videoId,
    total,
    offset,
    items: rows.map((r) => ({
      roundId: r.id,
      roundNumber: r.round_number ?? 0,
      status: r.status,
      provenance: r.provenance ?? "current",
      startedAt: r.started_at,
      transcriptId: r.transcript_id,
    })),
    hasMore: offset + rows.length < total,
  };
  return NextResponse.json(body);
}
