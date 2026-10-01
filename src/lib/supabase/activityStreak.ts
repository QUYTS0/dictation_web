import type { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeStreakFromDays, isValidTimeZone, localDayKey, streakDayKeys } from "@/lib/utils/streak";
import { mapLearningReadError } from "@/lib/supabase/learningReadErrors";

export interface ActivityStreak {
  streakDays: number;
  /** The zone "today" was evaluated in (the viewer's, or UTC as fallback). */
  streakTimeZone: string;
  /** The viewer's local date the streak was evaluated against. */
  streakToday: string;
  /** Some day in the CURRENT streak is known only from a UTC-dated record
   *  (activity from before local dating, or sent without a timezone). */
  streakIncludesUtcFallback: boolean;
}

/**
 * The viewer's timezone from the request's `tz` query parameter. Missing or
 * not a valid IANA name → UTC (documented fallback, never an error: a
 * streak is a convenience read).
 */
export function viewerTimeZoneFrom(url: string): string {
  const tz = new URL(url).searchParams.get("tz");
  return isValidTimeZone(tz) ? tz : "UTC";
}

/**
 * The ONE streak source shared by the Dashboard and the practice header:
 * the activity dates fn_activity_days returns (local dates per activity
 * batch, UTC for history), counted back from the viewer's local today.
 */
export async function loadActivityStreak(
  supabase: SupabaseClient,
  timeZone: string,
  now: Date = new Date()
): Promise<{ ok: true; streak: ActivityStreak } | { ok: false; response: NextResponse }> {
  const { data, error } = await supabase.rpc("fn_activity_days");
  if (error) return { ok: false, response: mapLearningReadError(error, "activity-days") };
  const result = (data ?? {}) as { days?: string[]; utcFallbackDays?: string[] };
  const days = Array.isArray(result.days) ? result.days : [];
  const fallback = new Set(Array.isArray(result.utcFallbackDays) ? result.utcFallbackDays : []);
  const today = localDayKey(now, timeZone);
  return {
    ok: true,
    streak: {
      streakDays: computeStreakFromDays(days, today),
      streakTimeZone: timeZone,
      streakToday: today,
      streakIncludesUtcFallback: streakDayKeys(days, today).some((d) => fallback.has(d)),
    },
  };
}
