"use client";

import { useQuery } from "@tanstack/react-query";
import type { SessionReportResponse } from "@/lib/types";

export const roundReportKeys = {
  /** One explicit round of this user — independent of the practice page's current-round state. */
  report: (userId: string | undefined, roundId: string | null | undefined) => ["round-report", userId, roundId ?? null] as const,
  allForUser: (userId: string | undefined) => ["round-report", userId] as const,
};

export async function fetchRoundReport(roundId: string): Promise<SessionReportResponse> {
  const res = await fetch(`/api/session/${encodeURIComponent(roundId)}/report`);
  if (!res.ok) {
    const err = new Error(res.status === 404 ? "Round not found" : "Failed to load the round report") as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * The whole-round report (every study session of the round). Used by the
 * practice page's completion view AND the full report page — one contract,
 * one cache entry per (user, round), so both always show the same numbers.
 */
export function useRoundReportQuery(userId: string | undefined, roundId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: roundReportKeys.report(userId, roundId),
    queryFn: () => fetchRoundReport(roundId as string),
    enabled: enabled && !!userId && !!roundId,
    retry: (count, error) => (error as { status?: number }).status !== 404 && count < 2,
  });
}
