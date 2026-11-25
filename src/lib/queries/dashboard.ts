"use client";

import { useQuery } from "@tanstack/react-query";
import type { ErrorType } from "@/lib/types";
import type { DashboardMistakeExample, DashboardSummary, DashboardWeek } from "@/lib/types/learning";
import { viewerTimeZone } from "@/lib/utils/streak";

export type { DashboardSummary };

export interface DashboardErrorPatterns {
  total: number;
  patterns: Array<{ errorType: ErrorType; count: number; percentage: number }>;
}

export const dashboardKeys = {
  summary: (userId: string | undefined) => ["dashboard-summary", userId] as const,
  errorPatterns: (userId: string | undefined) => ["dashboard-error-patterns", userId] as const,
  mistakeExamples: (userId: string | undefined) => ["dashboard-mistake-example", userId] as const,
  mistakeExample: (userId: string | undefined, errorType: ErrorType | null) => ["dashboard-mistake-example", userId, errorType] as const,
  week: (userId: string | undefined) => ["dashboard-week", userId] as const,
};

/** The latest recorded mistake of the selected type (diagnostics panel). */
export function useDashboardMistakeExampleQuery(userId: string | undefined, errorType: ErrorType | null) {
  return useQuery({
    queryKey: dashboardKeys.mistakeExample(userId, errorType),
    queryFn: async (): Promise<DashboardMistakeExample | null> => {
      const res = await fetch(`/api/dashboard/mistake-example?errorType=${encodeURIComponent(errorType ?? "")}`);
      if (!res.ok) throw new Error("Failed to load an example");
      return ((await res.json()) as { example: DashboardMistakeExample | null }).example;
    },
    enabled: !!userId && !!errorType,
  });
}

/** `?tz=<browser IANA zone>` — the streak's "today" is the viewer's local
 *  date. Shared by the Dashboard and the practice header (useStreak). */
export function streakQueryString(): string {
  const tz = viewerTimeZone();
  return tz ? `?tz=${encodeURIComponent(tz)}` : "";
}

async function fetchDashboardSummary(): Promise<DashboardSummary> {
  const res = await fetch(`/api/dashboard/summary${streakQueryString()}`);
  if (!res.ok) throw new Error("Failed to fetch dashboard summary");
  return res.json();
}

async function fetchErrorPatterns(): Promise<DashboardErrorPatterns> {
  const res = await fetch("/api/dashboard/error-patterns");
  if (!res.ok) throw new Error("Failed to fetch error patterns");
  return res.json();
}

/**
 * Shared by Dashboard and History — both render data from the same
 * GET /api/dashboard/summary response. Defining the query once here (rather
 * than each page inlining its own useQuery against the same key) is what
 * makes them actually share one cache entry/one in-flight request instead
 * of History independently duplicating Dashboard's fetch.
 */
export function useDashboardSummaryQuery(userId: string | undefined) {
  return useQuery({
    queryKey: dashboardKeys.summary(userId),
    queryFn: fetchDashboardSummary,
    enabled: !!userId,
  });
}

/**
 * The viewer's local days — the weekly track, Today's target and the 7-day
 * bars. Its own read, so a missing migration 047 (503) hides only those.
 */
export function useDashboardWeekQuery(userId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.week(userId),
    queryFn: async (): Promise<DashboardWeek> => {
      const res = await fetch(`/api/dashboard/week${streakQueryString()}`);
      if (!res.ok) throw new Error("Failed to fetch this week");
      const data = (await res.json()) as Partial<DashboardWeek> | null;
      // An unexpected body hides the track and target (an error), never a crash.
      if (!data || !Array.isArray(data.days) || typeof data.today !== "string" || typeof data.weekStart !== "string" || typeof data.goalMinutes !== "number") {
        throw new Error("Unexpected week response");
      }
      return data as DashboardWeek;
    },
    enabled: !!userId && enabled,
  });
}

export function useDashboardErrorPatternsQuery(userId: string | undefined) {
  return useQuery({
    queryKey: dashboardKeys.errorPatterns(userId),
    queryFn: fetchErrorPatterns,
    enabled: !!userId,
  });
}
