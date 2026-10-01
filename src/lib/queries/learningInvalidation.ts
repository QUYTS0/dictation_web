import type { QueryClient } from "@tanstack/react-query";
import { dashboardKeys } from "@/lib/queries/dashboard";
import { historyMistakesKeys } from "@/lib/queries/historyMistakes";
import { historySessionsKeys } from "@/lib/queries/historySessions";
import { roundReportKeys } from "@/lib/queries/roundReport";
import { videoLibraryKeys } from "@/lib/queries/videoLibrary";

/**
 * Marks the account-wide learning views stale after a CONFIRMED write
 * (plan §11.2, adapted to what the responses actually carry): no response
 * carries the account-wide aggregates these views need, so they are
 * invalidated, never patched. Invalidation only marks them stale — a view
 * refetches when it is (next) observed, keeping its current content on
 * screen meanwhile; an in-flight refetch is cancelled and restarted, so an
 * older read can't land after this write.
 *
 * Scoped to the user the write was made FOR (captured by the caller), never
 * "whoever is signed in now".
 */
export function invalidateLearningViews(
  qc: QueryClient,
  userId: string,
  opts: { roundIds?: Array<string | null | undefined>; mistakes?: boolean } = {}
): void {
  void qc.invalidateQueries({ queryKey: dashboardKeys.summary(userId) });
  void qc.invalidateQueries({ queryKey: videoLibraryKeys.allForUser(userId) });
  void qc.invalidateQueries({ queryKey: historySessionsKeys.allForUser(userId) });
  for (const roundId of opts.roundIds ?? []) {
    if (roundId) void qc.invalidateQueries({ queryKey: roundReportKeys.report(userId, roundId) });
  }
  if (opts.mistakes) {
    void qc.invalidateQueries({ queryKey: historyMistakesKeys.allForUser(userId) });
    void qc.invalidateQueries({ queryKey: dashboardKeys.errorPatterns(userId) });
  }
}
