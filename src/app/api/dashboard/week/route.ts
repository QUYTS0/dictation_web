import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLearningReadError } from "@/lib/supabase/learningReadErrors";
import { loadActivityDays, viewerTimeZoneFrom } from "@/lib/supabase/activityStreak";
import { DEFAULT_DAILY_GOAL_MINUTES, isDailyGoalChoice } from "@/lib/constants/dailyGoal";
import { addDaysToKey, localDayKey, mondayOfKey } from "@/lib/utils/streak";
import type { DashboardWeek } from "@/lib/types/learning";

/** Two weeks: enough for the Monday–Sunday track and the last 7 days. */
const WEEK_ROLLING_DAYS = 14;

/**
 * The Dashboard's day-by-day view (plan §3.6, Phase 4), for the viewer's
 * local calendar (`?tz=`, IANA; UTC fallback):
 *   practiced  the SAME day set as the streak (fn_activity_days: any mode,
 *              word reviews included), so a ✓ and the streak always agree
 *   activeSec  engaged time that day (fn_daily_activity, migration 047) —
 *              the same union rule as "Est. active practice"
 *   goal       the saved daily goal, or the default (goalIsDefault)
 * A read: it never records activity.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    const timeZone = viewerTimeZoneFrom(request.url);
    const today = localDayKey(new Date(), timeZone);
    const from = addDaysToKey(today, -(WEEK_ROLLING_DAYS - 1));

    const [activity, daily, profile] = await Promise.all([
      loadActivityDays(supabase),
      supabase.rpc("fn_daily_activity", { p_time_zone: timeZone, p_from: from, p_to: today }),
      supabase.rpc("fn_my_profile"),
    ]);
    if (!activity.ok) return activity.response;
    if (daily.error) return mapLearningReadError(daily.error, "dashboard/week", "047");
    if (profile.error) return mapLearningReadError(profile.error, "dashboard/week", "047");

    const seconds = new Map<string, number>();
    for (const row of (Array.isArray(daily.data) ? daily.data : []) as Array<{ date?: unknown; activeSec?: unknown }>) {
      if (typeof row.date === "string") seconds.set(row.date, Math.max(0, Number(row.activeSec) || 0));
    }
    const practiced = new Set(activity.days);
    const savedGoal = (profile.data as { dailyGoalMinutes?: unknown } | null)?.dailyGoalMinutes;

    const body: DashboardWeek = {
      timeZone,
      today,
      weekStart: mondayOfKey(today),
      days: Array.from({ length: WEEK_ROLLING_DAYS }, (_, i) => {
        const date = addDaysToKey(from, i);
        return { date, practiced: practiced.has(date), activeSec: seconds.get(date) ?? 0 };
      }),
      goalMinutes: isDailyGoalChoice(savedGoal) ? savedGoal : DEFAULT_DAILY_GOAL_MINUTES,
      goalIsDefault: !isDailyGoalChoice(savedGoal),
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error("[dashboard/week] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
