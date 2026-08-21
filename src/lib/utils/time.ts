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
