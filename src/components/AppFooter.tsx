"use client";

import clsx from "clsx";
import { useAuth } from "@/context/auth";
import { useStreakQuery } from "@/lib/queries/streak";
import { useLeaderboardQuery } from "@/lib/queries/leaderboard";
import { leagueName } from "@/lib/leagues/tiers";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";

/**
 * Quiet app-shell footer for the scrolling signed-in pages (not the
 * Vocabulary bank, which is a fixed-viewport layout, nor the practice
 * workspace). Reads the same streak cache entry as the header pill, and —
 * when this session already loaded it — the league board (cached only: the
 * footer never triggers a board read, which may place the learner in a group).
 */
export default function AppFooter() {
  const { user } = useAuth();
  const streak = useStreakQuery(user?.id).data;
  const league = useLeaderboardQuery(user?.id, "week", false).data;
  const leagueRank = league?.status === "member" ? league.you?.rank : undefined;

  return (
    <footer className="mt-auto border-t border-line bg-white py-6 text-xs text-muted">
      <div
        className={clsx(
          "mx-auto flex w-full flex-col items-center justify-between gap-3 sm:flex-row",
          PAGE_WIDTH_CLASS.wide,
          PAGE_PADDING_CLASS.wide
        )}
      >
        <p className="flex flex-wrap items-center justify-center gap-x-2">
          <span className="font-semibold text-ink">DictaLearn</span>
          <span aria-hidden="true">·</span>
          <span>English listening, dictation &amp; shadowing studio</span>
        </p>
        {user && (streak || leagueRank) && (
          <p className="flex flex-wrap items-center justify-center gap-x-2 font-mono">
            {streak && (
              <span data-testid="footer-streak">
                Streak:{" "}
                <strong className="text-ink">
                  {streak.streakDays} {streak.streakDays === 1 ? "day" : "days"}
                </strong>
              </span>
            )}
            {streak && league && leagueRank && <span aria-hidden="true">·</span>}
            {league && leagueRank && (
              <span data-testid="footer-league">
                League:{" "}
                <strong className="text-ink">
                  {leagueName(league.tier)} #{leagueRank}
                </strong>
              </span>
            )}
          </p>
        )}
      </div>
    </footer>
  );
}
