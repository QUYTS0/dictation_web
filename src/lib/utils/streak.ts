// =====================================================
// Daily practice streak calculation
// =====================================================

const DAY_MS = 24 * 60 * 60 * 1000;

function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Counts the current consecutive-day practice streak given a list of
 * timestamps the user was active (e.g. attempt_logs.created_at). The streak
 * only counts if the user practiced today or yesterday (UTC calendar days);
 * otherwise it's considered broken and returns 0.
 */
export function computeStreakDays(activityDates: Date[], now: Date = new Date()): number {
  const dayKeys = new Set(activityDates.map(toDayKey));

  const todayKey = toDayKey(now);
  const yesterdayKey = toDayKey(new Date(now.getTime() - DAY_MS));

  let cursor: Date;
  if (dayKeys.has(todayKey)) {
    cursor = now;
  } else if (dayKeys.has(yesterdayKey)) {
    cursor = new Date(now.getTime() - DAY_MS);
  } else {
    return 0;
  }

  let streak = 0;
  while (dayKeys.has(toDayKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return streak;
}
