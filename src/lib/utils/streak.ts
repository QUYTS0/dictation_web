// =====================================================
// Daily learning streak (calendar days with practice in any mode)
// =====================================================
//
// Day keys are YYYY-MM-DD calendar dates. The database dates each activity
// batch in the IANA timezone the browser captured when the activity
// happened (fn_activity_days, migration 040); records without one keep a
// documented UTC date. "Today" is the viewer's local date in their current
// browser timezone. Calendar arithmetic only — never "now minus 24 hours" —
// so DST days of 23 or 25 hours can't skip or repeat a date.

/** The IANA name shapes the database accepts (fn_valid_time_zone, migration
 *  040): Area/Location, UTC, GMT or Etc/GMT±N — never POSIX offsets
 *  ("UTC+7"), abbreviations ("PST") or "localtime". */
const IANA_SHAPE = /^(?:[A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC|GMT|Etc\/GMT[+-](?:[0-9]|1[0-4]))$/;

/** A real IANA zone name (Intl accepts it), at most 64 characters. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) return false;
  if (!IANA_SHAPE.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The browser's resolved IANA timezone (client side), or null. */
export function viewerTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : null;
  } catch {
    return null;
  }
}

/** The calendar date (YYYY-MM-DD) of `instant` in `timeZone`. */
export function localDayKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** The calendar date before a YYYY-MM-DD key (pure date arithmetic). */
export function previousDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * Consecutive calendar days with practice, ending today or yesterday
 * (`todayKey` = the viewer's local date). A day missing in between ends the
 * streak; the latest practice being two or more days ago means 0. Several
 * events on one date are one day.
 */
export function computeStreakFromDays(dayKeys: Iterable<string>, todayKey: string): number {
  const days = new Set(dayKeys);
  let cursor = days.has(todayKey) ? todayKey : previousDayKey(todayKey);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = previousDayKey(cursor);
  }
  return streak;
}

/** The dates that make up the current streak (newest first). */
export function streakDayKeys(dayKeys: Iterable<string>, todayKey: string): string[] {
  const days = new Set(dayKeys);
  const out: string[] = [];
  let cursor = days.has(todayKey) ? todayKey : previousDayKey(todayKey);
  while (days.has(cursor)) {
    out.push(cursor);
    cursor = previousDayKey(cursor);
  }
  return out;
}
