import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadActivityStreak, viewerTimeZoneFrom } from "@/lib/supabase/activityStreak";

/**
 * Lightweight streak-only endpoint (vs. the heavier /api/dashboard/summary)
 * so the practice page can show the daily learning streak. Same source and
 * rule as the Dashboard (loadActivityStreak): calendar days with practice in
 * any mode — local dates per activity batch, UTC for older records —
 * counted back from the viewer's local today (`?tz=`, IANA; UTC fallback).
 * A read: it never records activity.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    const result = await loadActivityStreak(supabase, viewerTimeZoneFrom(request.url));
    if (!result.ok) return result.response;
    return NextResponse.json(result.streak);
  } catch (err) {
    console.error("[streak] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
