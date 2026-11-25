/**
 * The daily target in minutes of active practice (plan D3). The database
 * accepts exactly these values (users_daily_goal_minutes_check, migration
 * 047); an unset goal means the default. The goal is a preference only: it
 * never changes XP or any metric.
 */
export const DAILY_GOAL_CHOICES = [10, 15, 20, 30, 45, 60] as const;
export type DailyGoalMinutes = (typeof DAILY_GOAL_CHOICES)[number];
export const DEFAULT_DAILY_GOAL_MINUTES: DailyGoalMinutes = 15;

export function isDailyGoalChoice(value: unknown): value is DailyGoalMinutes {
  return typeof value === "number" && (DAILY_GOAL_CHOICES as readonly number[]).includes(value);
}
