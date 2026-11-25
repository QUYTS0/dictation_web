"use client";

import { useRef, useState } from "react";
import clsx from "clsx";
import { Check, Shield, Trophy } from "lucide-react";
import AppHeader from "@/components/AppHeader";
import AppFooter from "@/components/AppFooter";
import { ProfileDialog } from "@/components/ProfileDialog";
import { LeagueAllTimeRows, LeagueWeekRows } from "@/components/league/LeagueRows";
import { LeaguePrivacyNotice } from "@/components/league/LeaguePrivacyNotice";
import { useAuth } from "@/context/auth";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import { DEMOTION_COUNT, DEMOTION_MIN_GROUP, LEAGUE_TIERS, PROMOTION_COUNT, formatLeagueReset, lastWeekResultText, leagueName, zoneText } from "@/lib/leagues/tiers";
import { useLeaderboardQuery } from "@/lib/queries/leaderboard";
import type { LeagueTier } from "@/lib/types/leaderboard";

const card = "rounded-2xl border border-line bg-white p-5 shadow-xs";

function TierLadder({ current }: { current: LeagueTier }) {
  return (
    <section aria-labelledby="ladder-heading" className={card}>
      <h2 id="ladder-heading" className="mb-3 text-xs font-bold uppercase tracking-wider text-ink">
        Leagues
      </h2>
      <ol data-testid="tier-ladder" className="space-y-1.5">
        {[...LEAGUE_TIERS].reverse().map((t) => (
          <li
            key={t}
            aria-current={t === current ? "step" : undefined}
            className={clsx(
              "flex items-center justify-between rounded-lg px-3 py-1.5 text-sm",
              t === current ? "bg-primary-50 font-bold text-primary-700" : t < current ? "text-muted" : "text-ink"
            )}
          >
            <span>{leagueName(t)}</span>
            {t === current ? <span className="text-xs font-semibold">You are here</span> : t < current ? <Check size={14} aria-label="passed" /> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The leaderboard (plan §4.4): the learner's whole league group this week
 * (≤ 30) with promotion and demotion zones, the league ladder, last week's
 * result, the all-time top 5, and how the learner appears — with a way to
 * change it (D7). Reading it also places an eligible learner in this
 * week's group (fn_league_board, migration 050).
 */
export default function LeaderboardPage() {
  const { user, loading, openAuthModal } = useAuth();
  const userId = user?.id;
  const week = useLeaderboardQuery(userId, "week");
  const allTime = useLeaderboardQuery(userId, "all", !!week.data && week.data.status !== "hidden");
  const [prefsOpen, setPrefsOpen] = useState(false);
  const returnRef = useRef<HTMLElement | null>(null);
  const openPreferences = () => {
    returnRef.current = document.activeElement as HTMLElement | null;
    setPrefsOpen(true);
  };
  const board = week.data;
  const zone = board ? zoneText(board) : null;

  return (
    <div className="relative flex min-h-screen w-full flex-1 flex-col bg-page font-sans text-ink antialiased">
      <AppHeader active="leaderboard" />
      <main className={clsx("mx-auto flex w-full flex-1 flex-col gap-6 py-8", PAGE_WIDTH_CLASS.wide, PAGE_PADDING_CLASS.wide)}>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight text-ink">
            <Trophy size={22} className="text-reward" aria-hidden="true" />
            Leaderboard
          </h1>
          <p className="mt-1 text-sm text-muted">
            Weekly leagues ranked by XP. The top {PROMOTION_COUNT} move up; in groups of {DEMOTION_MIN_GROUP} or more, the bottom {DEMOTION_COUNT} move down.
            {board && <> Resets {formatLeagueReset(board.weekEndsAt)}.</>}
          </p>
        </div>

        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : !user ? (
          <section className={card}>
            <p className="text-sm text-muted">Sign in to see your league.</p>
            <button onClick={openAuthModal} className="mt-3 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700">
              Sign in
            </button>
          </section>
        ) : week.isError && !board ? (
          <p className="text-sm text-red-600">The leaderboard isn&apos;t available right now. Please try again later.</p>
        ) : !board ? (
          <div aria-busy="true" aria-label="Loading the leaderboard" className="min-h-[320px] animate-pulse rounded-2xl border border-line bg-white" />
        ) : (
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
            <section aria-labelledby="week-heading" className={clsx(card, "lg:col-span-8")}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="week-heading" className="text-sm font-bold text-ink">
                  {leagueName(board.tier)} League · this week
                </h2>
                {board.status === "member" && <span className="font-mono text-xs text-muted">{board.rows.length} in your group</span>}
              </div>
              {board.status === "hidden" ? (
                <div data-testid="leaderboard-hidden" className="space-y-2 text-sm text-muted">
                  <p>You&apos;re hidden from leaderboards, so you don&apos;t see them either.</p>
                  <button type="button" onClick={openPreferences} className="font-semibold text-primary-600 hover:text-primary-700">
                    Show me in Preferences
                  </button>
                </div>
              ) : board.status === "not_joined" ? (
                <p data-testid="leaderboard-not-joined" className="text-sm text-muted">
                  Practice anything this week to join this week&apos;s {leagueName(board.tier)} league.
                </p>
              ) : (
                <>
                  {zone && (
                    <p data-testid="leaderboard-zone" className="mb-3 rounded-xl bg-surface px-3 py-2 text-xs text-ink">
                      {zone}
                    </p>
                  )}
                  <LeagueWeekRows rows={board.rows} userId={userId} showZones />
                  <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-1 rounded-full bg-success" aria-hidden="true" /> Promotion zone
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-1 rounded-full bg-danger" aria-hidden="true" /> Demotion zone
                    </span>
                  </p>
                </>
              )}
            </section>

            <div className="space-y-5 lg:col-span-4">
              <TierLadder current={board.tier} />

              {board.lastWeek && (
                <section aria-labelledby="last-week-heading" className={card}>
                  <h2 id="last-week-heading" className="mb-1.5 text-xs font-bold uppercase tracking-wider text-ink">
                    Last week
                  </h2>
                  <p data-testid="leaderboard-last-week" className="text-sm text-ink">
                    You {lastWeekResultText(board.lastWeek)}
                    {board.lastWeek.xp !== null && <span className="text-muted"> · {board.lastWeek.xp.toLocaleString()} XP</span>}
                  </p>
                </section>
              )}

              {board.status !== "hidden" && (
                <section aria-labelledby="alltime-heading" className={card}>
                  <h2 id="alltime-heading" className="mb-3 text-xs font-bold uppercase tracking-wider text-ink">
                    All time
                  </h2>
                  {allTime.data ? (
                    <>
                      <LeagueAllTimeRows rows={allTime.data.rows} you={allTime.data.you} />
                      <p className="mt-2 text-[11px] text-muted">Updated hourly.</p>
                    </>
                  ) : allTime.isError ? (
                    <p className="text-sm text-muted">Couldn&apos;t load the all-time ranking.</p>
                  ) : (
                    <div aria-busy="true" aria-label="Loading the all-time ranking" className="h-32 animate-pulse rounded-xl bg-surface" />
                  )}
                </section>
              )}

              <section aria-labelledby="privacy-heading" data-testid="leaderboard-privacy" className={card}>
                <h2 id="privacy-heading" className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink">
                  <Shield size={14} className="text-primary-600" aria-hidden="true" /> Your privacy
                </h2>
                <p className="mb-3 text-xs leading-relaxed text-muted">
                  Everyone takes part under a generated nickname unless they choose a public name or hide. Boards show names, weekly XP, streaks and
                  kudos — never emails or photos.
                </p>
                {board.status === "hidden" ? (
                  <button type="button" onClick={openPreferences} className="text-xs font-semibold text-primary-600 hover:text-primary-700">
                    Change name or visibility
                  </button>
                ) : (
                  userId && <LeaguePrivacyNotice userId={userId} displayName={board.displayName} onOpenPreferences={openPreferences} persistent />
                )}
              </section>
            </div>
          </div>
        )}
      </main>
      <AppFooter />
      {prefsOpen && <ProfileDialog onClose={() => setPrefsOpen(false)} returnFocusRef={returnRef} />}
    </div>
  );
}
