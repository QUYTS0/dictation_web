import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isVideoId } from "@/lib/supabase/learningReadErrors";
import type { TranscriptVersionsResponse } from "@/lib/types/learning";

interface RouteParams {
  params: Promise<{ videoId: string }>;
}

/**
 * Script Versions listing (Phase 9, plan §6.9/§10.7): every revision of the
 * video's English script with its status, sentence count, size estimate,
 * the caller's OWN round association and the retention classification —
 * computed by fn_transcript_versions (migration 041). Read-only apart from
 * lazily refreshing stale size estimates. Deletion is not offered:
 * `deletionEnabled` is always false in v1.
 */
export async function GET(_request: Request, { params }: RouteParams) {
  const { videoId } = await params;
  if (!isVideoId(videoId)) return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data, error } = await supabase.rpc("fn_transcript_versions", { p_youtube_video_id: videoId, p_language: "en" });
  if (error || !data) {
    if (error?.message === "invalid_payload") return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
    if (error?.message === "authentication_required") return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    if (error?.code === "PGRST202" || error?.code === "42883") {
      console.error("[transcripts/versions] fn_transcript_versions missing — apply migration 041 before deploying this app", error);
      return NextResponse.json({ error: "Script versions are not available yet.", code: "script_versions_unavailable" }, { status: 503 });
    }
    console.error("[transcripts/versions] RPC error:", error);
    return NextResponse.json({ error: "Couldn't load script versions." }, { status: 500 });
  }
  return NextResponse.json(data as TranscriptVersionsResponse);
}
