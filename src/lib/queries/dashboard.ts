"use client";

import { useQuery } from "@tanstack/react-query";
import type { ErrorType, ResumableSession } from "@/lib/types";

export interface DashboardSummary {
  completedVideos: number;
  avgAccuracy: number;
  totalPracticeMinutes: number;
  vocabularyCount: number;
  streakDays: number;
  recentVocabulary: Array<{
    id: string;
    term: string;
    sentence_context: string;
    created_at: string;
  }>;
  resumableSessions: ResumableSession[];
}

export interface DashboardErrorPatterns {
  total: number;
  patterns: Array<{ errorType: ErrorType; count: number; percentage: number }>;
}

export const dashboardKeys = {
  summary: (userId: string | undefined) => ["dashboard-summary", userId] as const,
  errorPatterns: (userId: string | undefined) => ["dashboard-error-patterns", userId] as const,
};

async function fetchDashboardSummary(): Promise<DashboardSummary> {
  const res = await fetch("/api/dashboard/summary");
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

export function useDashboardErrorPatternsQuery(userId: string | undefined) {
  return useQuery({
    queryKey: dashboardKeys.errorPatterns(userId),
    queryFn: fetchErrorPatterns,
    enabled: !!userId,
  });
}
