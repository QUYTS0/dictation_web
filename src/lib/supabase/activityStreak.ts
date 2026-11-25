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
  /** Practice is already recorded on `streakToday` (the streak is safe for
   *  today). False means the streak — if any — ends yesterday so far. */
  streakActiveToday: boolean;
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
 * The practice days (YYYY-MM-DD) fn_activity_days returns: local dates per
 * activity batch and per word review, UTC for history. The ONE day set
 * behind the streak AND the Dashboard's weekly track ✓ marks.
 */
export async function loadActivityDays(
  supabase: SupabaseClient
): Promise<{ ok: true; days: string[]; utcFallbackDays: Set<string> } | { ok: false; response: NextResponse }> {
  const { data, error } = await supabase.rpc("fn_activity_days");
  if (error) return { ok: false, response: mapLearningReadError(error, "activity-days") };
  const result = (data ?? {}) as { days?: string[]; utcFallbackDays?: string[] };
  return {
    ok: true,
    days: Array.isArray(result.days) ? result.days : [],
    utcFallbackDays: new Set(Array.isArray(result.utcFallbackDays) ? result.utcFallbackDays : []),
  };
}

/**
 * The ONE streak source shared by the Dashboard and the practice header:
 * the practice days (loadActivityDays) counted back from the viewer's local
 * today.
 */
export async function loadActivityStreak(
  supabase: SupabaseClient,
  timeZone: string,
  now: Date = new Date()
): Promise<{ ok: true; streak: ActivityStreak } | { ok: false; response: NextResponse }> {
  const loaded = await loadActivityDays(supabase);
  if (!loaded.ok) return loaded;
  const { days, utcFallbackDays: fallback } = loaded;
  const today = localDayKey(now, timeZone);
  return {
    ok: true,
    streak: {
      streakDays: computeStreakFromDays(days, today),
      streakTimeZone: timeZone,
      streakToday: today,
      streakActiveToday: days.includes(today),
      streakIncludesUtcFallback: streakDayKeys(days, today).some((d) => fallback.has(d)),
    },
  };
}
