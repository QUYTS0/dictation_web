import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import { isKnownTrack, type AchievementsResponse, type AchievementTrack, type AchievementUnlock } from "@/lib/types/achievements";

/**
 * The learner's achievements (plan §3.4, Phase 6): fn_sync_achievements
 * (migration 049) recomputes every metric server-side, records newly met
 * tiers and returns all tracks plus what this call unlocked. A GET because
 * it takes no input and is idempotent — repeating it never unlocks
 * anything twice or announces an unlock twice. Thresholds come from the
 * database; tracks this app version doesn't know are left out.
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    const { data, error } = await supabase.rpc("fn_sync_achievements");
    if (error || !data) return mapLearningReadError(error, "achievements", "049");

    const raw = data as { tracks?: AchievementTrack[]; newlyUnlocked?: AchievementUnlock[] };
    const body: AchievementsResponse = {
      tracks: (raw.tracks ?? [])
        .filter((t) => isKnownTrack(t.track))
        .map((t) => ({
          track: t.track,
          value: Number(t.value) || 0,
          tiers: (t.tiers ?? []).map((x) => ({ tier: x.tier, threshold: Number(x.threshold), unlockedAt: x.unlockedAt ?? null })),
        })),
      newlyUnlocked: (raw.newlyUnlocked ?? []).filter((u) => isKnownTrack(u.track)),
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error("[achievements] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
