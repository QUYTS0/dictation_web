"use client";

import { useQuery } from "@tanstack/react-query";
import type { ShadowingRoundResults } from "@/lib/practice/shadowingTypes";

/**
 * The saved Shadowing results of ONE round (GET /api/practice/attempts?roundId=,
 * fn_shadowing_round_results — owner-only, read-only). One cache entry per
 * (user, round): the practice page writes its own reads into it
 * (useShadowingEvaluations) and the round reports read it lazily, so both
 * show the same saved evidence; invalidateLearningViews marks it stale after
 * a confirmed save.
 */
export const shadowingRoundResultsKeys = {
  round: (userId: string | undefined, roundId: string | null | undefined) => ["shadowing-round-results", userId, roundId ?? null] as const,
  allForUser: (userId: string | undefined) => ["shadowing-round-results", userId] as const,
};

export async function fetchShadowingRoundResults(roundId: string, signal?: AbortSignal): Promise<ShadowingRoundResults> {
  const res = await fetch(`/api/practice/attempts?roundId=${encodeURIComponent(roundId)}`, { signal });
  if (!res.ok) {
    const err = new Error(res.status === 404 ? "Round not found" : "Failed to load saved recordings") as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Loads only while `enabled` (e.g. the report's feedback section is open); an obsolete request is aborted. */
export function useShadowingRoundResultsQuery(userId: string | undefined, roundId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: shadowingRoundResultsKeys.round(userId, roundId),
    queryFn: ({ signal }) => fetchShadowingRoundResults(roundId as string, signal),
    enabled: enabled && !!userId && !!roundId,
    retry: (count, error) => (error as { status?: number }).status !== 404 && count < 2,
  });
}
