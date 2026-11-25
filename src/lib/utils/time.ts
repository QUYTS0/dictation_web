// =====================================================
// Duration formatting — used anywhere "time spent" is shown
// (dashboard practice time, history totals, session reports).
// =====================================================

/** Formats a minute count as "45m" or, once past an hour, "1h 5m". */
export function formatMinutesAsHm(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

/** Formats a second count as "45s" under a minute, otherwise hours+minutes. */
export function formatDurationSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  return formatMinutesAsHm(seconds / 60);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When something last happened, in the viewer's local calendar days:
 * "today", "yesterday", "3 days ago", or a short date from 30 days on.
 * Calendar-day arithmetic (rounded), so 23/25-hour DST days don't skew it.
 * A future timestamp (clock skew) reads as "today"; an invalid one is null.
 */
export function formatLastActive(iso: string, now: Date = new Date()): string | null {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(then)) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
