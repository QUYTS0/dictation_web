import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import { viewerTimeZoneFrom } from "@/lib/supabase/activityStreak";
import { levelProgress } from "@/lib/xp/levels";
import type { XpSummary } from "@/lib/types/xp";

/**
 * The caller's XP (plan §3.3, Phase 5): calculated by the database from the
 * stored practice records (fn_my_xp, migration 048, rules v1) — never
 * awarded or stored. `?tz=` (IANA; UTC fallback) only decides which local
 * dates "today" and the 14 days are. The level is derived here from the
 * total (50·L·(L−1)). A read: it never records anything.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    const { data, error } = await supabase.rpc("fn_my_xp", { p_time_zone: viewerTimeZoneFrom(request.url) });
    if (error || !data) return mapLearningReadError(error, "xp", "048");

    const raw = data as Omit<XpSummary, "level" | "levelStartXp" | "nextLevelXp">;
    const totalXp = Number(raw.totalXp) || 0;
    const { level, levelStartXp, nextLevelXp } = levelProgress(totalXp);
    const body: XpSummary = { ...raw, totalXp, level, levelStartXp, nextLevelXp };
    return NextResponse.json(body);
  } catch (err) {
    console.error("[xp] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
