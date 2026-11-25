import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import { loadActivityStreak, viewerTimeZoneFrom } from "@/lib/supabase/activityStreak";
import { initialsOf } from "@/lib/leagues/tiers";
import type { LeagueAllTimeBoard, LeagueAllTimeRow, LeagueBoard, LeagueWeekBoard, LeagueWeekRow } from "@/lib/types/leaderboard";

/**
 * The league board (plan §3.5, Phase 7) — fn_league_board (migration 050):
 *   ?scope=week (default)  the caller's group this week; reading it also
 *                          finalizes past weeks and places an eligible
 *                          caller in a group (idempotent; no input)
 *   ?scope=all             the global top 5 by total XP + the caller's rank
 *                          (an hourly snapshot)
 * Rows carry names, initials, XP, streaks and kudos — never an email, user
 * id or avatar. The caller's own streak is their viewer-local one (`?tz=`,
 * the same loader as the header), not the database's XP-zone estimate.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    const scope = new URL(request.url).searchParams.get("scope") === "all" ? "all" : "week";
    const [board, streak] = await Promise.all([
      supabase.rpc("fn_league_board", { p_scope: scope }),
      scope === "week" ? loadActivityStreak(supabase, viewerTimeZoneFrom(request.url)) : Promise.resolve(null),
    ]);
    if (board.error || !board.data) return mapLearningReadError(board.error, "leaderboard", "050");

    const raw = board.data as Omit<LeagueBoard, "rows"> & { rows?: Array<Record<string, unknown>> };
    const base = {
      status: raw.status,
      tier: raw.tier,
      weekStart: raw.weekStart,
      weekEndsAt: raw.weekEndsAt,
      displayName: raw.displayName,
      lastWeek: raw.lastWeek ?? null,
    };

    if (scope === "all") {
      const all = raw as unknown as LeagueAllTimeBoard;
      const rows: LeagueAllTimeRow[] = (raw.rows ?? []).map((r) => ({
        rank: Number(r.rank),
        name: String(r.name),
        initials: initialsOf(String(r.name)),
        totalXp: Number(r.totalXp) || 0,
        isYou: r.isYou === true,
      }));
      const body: LeagueAllTimeBoard = { scope: "all", ...base, rows, you: all.you ?? null, refreshedAt: all.refreshedAt ?? null };
      return NextResponse.json(body);
    }

    const ownStreak = streak && streak.ok ? streak.streak.streakDays : null;
    const rows: LeagueWeekRow[] = (raw.rows ?? []).map((r) => ({
      rank: Number(r.rank),
      memberKey: String(r.memberKey),
      name: String(r.name),
      initials: initialsOf(String(r.name)),
      weekXp: Number(r.weekXp) || 0,
      streakDays: r.isYou === true && ownStreak !== null ? ownStreak : Number(r.streakDays) || 0,
      kudos: Number(r.kudos) || 0,
      youGaveKudos: r.youGaveKudos === true,
      isYou: r.isYou === true,
      zone: r.zone === "promotion" || r.zone === "demotion" ? r.zone : "safe",
    }));
    const mine = rows.find((r) => r.isYou);
    const third = rows.find((r) => r.rank === 3);
    const you: LeagueWeekBoard["you"] = mine
      ? {
          rank: mine.rank,
          weekXp: mine.weekXp,
          zone: mine.zone,
          // XP that would lift the learner past the current #3 (ties go to the earlier joiner).
          gapToPromotionXp: mine.zone === "promotion" || base.tier === 6 || !third ? null : Math.max(1, third.weekXp - mine.weekXp + 1),
        }
      : null;
    const body: LeagueWeekBoard = { scope: "week", ...base, rows, you };
    return NextResponse.json(body);
  } catch (err) {
    console.error("[leaderboard] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
