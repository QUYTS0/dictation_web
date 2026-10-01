import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import { LIBRARY_FILTERS, type LibraryFilter, type LibraryPage } from "@/lib/types/learning";

/**
 * The caller's video Library — one card per video, anchored on their
 * membership rows, with every learning fact read from the authoritative
 * tables (fn_video_library, migration 040). Sorted by last activity (then
 * video id), offset-paginated. A read never adds membership.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const filter = (params.get("filter") || "all") as LibraryFilter;
  const limit = Number(params.get("limit") ?? 12);
  const offset = Number(params.get("offset") ?? 0);
  if (!LIBRARY_FILTERS.includes(filter) || !Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0) {
    return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("fn_video_library", { p_limit: limit, p_offset: offset, p_filter: filter });
  if (error || !data) return mapLearningReadError(error, "videos/library");
  return NextResponse.json(data as LibraryPage);
}
