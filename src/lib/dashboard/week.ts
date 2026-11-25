import type { DashboardWeek, DashboardWeekDay } from "@/lib/types/learning";
import type { XpDay } from "@/lib/types/xp";
import { addDaysToKey } from "@/lib/utils/streak";
import { formatXp } from "@/lib/xp/levels";

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export type TrackDayState = "done" | "missed" | "today" | "future";

export interface TrackDay extends DashboardWeekDay {
  weekday: (typeof WEEKDAY_LABELS)[number];
  state: TrackDayState;
}

/** Whole minutes of active practice — rounded DOWN, so "15 / 15 min" never
 *  shows before the goal is really met. */
export const activeMinutes = (activeSec: number) => Math.floor(Math.max(0, activeSec) / 60);

/**
 * The hero's weekly track (plan §1, §4.5.5): Monday–Sunday of the viewer's
 * local week. ✓ (done) = any practice that day, the streak's own day set.
 * Today is always the ember marker (practiced or not); later days are
 * future. Days the rolling window doesn't cover can't be practiced ones
 * (it spans two weeks), so they count as missed.
 */
export function weeklyTrack(week: DashboardWeek): { days: TrackDay[]; activeCount: number; todayIndex: number } {
  const byDate = new Map(week.days.map((d) => [d.date, d]));
  const days = WEEKDAY_LABELS.map((weekday, i): TrackDay => {
    const date = addDaysToKey(week.weekStart, i);
    const known = byDate.get(date);
    const practiced = known?.practiced ?? false;
    const state: TrackDayState = date === week.today ? "today" : date > week.today ? "future" : practiced ? "done" : "missed";
    return { date, weekday, state, practiced: state !== "future" && practiced, activeSec: state === "future" ? 0 : (known?.activeSec ?? 0) };
  });
  return { days, activeCount: days.filter((d) => d.practiced).length, todayIndex: days.findIndex((d) => d.state === "today") };
}

/** Today's target: minutes so far against the goal (a preference only). */
export function goalProgress(week: DashboardWeek): { minutes: number; goalMinutes: number; pct: number; met: boolean } {
  const todaySec = week.days.find((d) => d.date === week.today)?.activeSec ?? 0;
  const goalSec = week.goalMinutes * 60;
  return {
    minutes: activeMinutes(todaySec),
    goalMinutes: week.goalMinutes,
    pct: goalSec > 0 ? Math.min(100, (100 * todaySec) / goalSec) : 0,
    met: goalSec > 0 && todaySec >= goalSec,
  };
}

/** The last seven local days, oldest first, ending today (the 7-day bars). */
export function lastSevenDays(week: DashboardWeek): DashboardWeekDay[] {
  const byDate = new Map(week.days.map((d) => [d.date, d]));
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDaysToKey(week.today, i - 6);
    return byDate.get(date) ?? { date, practiced: false, activeSec: 0 };
  });
}

/** "—", "<1m", "22m", "1h05", "2h" — the compact label under a track day
 *  (at most 4 characters: a seventh of a phone-width hero). */
export function formatDayMinutesShort(activeSec: number): string {
  if (activeSec <= 0) return "—";
  const min = activeMinutes(activeSec);
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

/** "0 min", "less than a minute", "22 min", "1 h 5 min" — spelled out for
 *  popovers and screen readers. */
export function formatDayMinutesLong(activeSec: number): string {
  if (activeSec <= 0) return "0 min";
  const min = activeMinutes(activeSec);
  if (min < 1) return "less than a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "Tue, Nov 18" (the viewer's locale) for a YYYY-MM-DD key — a calendar
 *  date, so it's formatted in UTC and never shifted by the machine's zone. */
export function formatDayKey(dayKey: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A practiced day's details (plan §4.5.5): its active time and what it held
 * — Dictation sentences, Shadowing sentences, words reviewed (first
 * occurrences, from the XP events) — then its XP. Zero values are left out;
 * a day with nothing to list is "Active". Without XP (unavailable), only
 * the time and "Active" (the Phase 4 content).
 */
export function dayDetails(day: DashboardWeekDay, xpDay: XpDay | undefined): { parts: string[]; xpLabel: string | null } {
  const a = xpDay?.activity;
  const parts = [
    day.activeSec > 0 ? formatDayMinutesLong(day.activeSec) : null,
    a && a.dictationSentences > 0 ? count(a.dictationSentences, "Dictation sentence", "Dictation sentences") : null,
    a && a.shadowingSentences > 0 ? count(a.shadowingSentences, "Shadowing sentence", "Shadowing sentences") : null,
    a && a.wordsReviewed > 0 ? count(a.wordsReviewed, "word reviewed", "words reviewed") : null,
  ].filter((p): p is string => !!p);
  if (parts.length === (day.activeSec > 0 ? 1 : 0)) parts.push("Active");
  return { parts, xpLabel: xpDay && xpDay.xp > 0 ? `+${formatXp(xpDay.xp)} XP` : null };
}
